/**
 * PixiJS scene for the map: layer sprites, vector overlays, and a pan/zoom camera.
 *
 * The world is measured in tiles — one world unit per tile — so camera scale reads
 * directly as "screen pixels per tile", which is what the zoom UI and the
 * label/outline thresholds care about.
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Entity } from '../coimap/schema.gen';
import type { LayerName, WorkerDoc } from '../coimap/types';
import { hasSparseFootprint } from '../coimap/footprint';

const MAX_ZOOM = 48;         // screen pixels per tile
const MIN_ZOOM_FACTOR = 0.6; // relative to the fit-to-screen scale
const ZOOM_PER_WHEEL_LINE = 1.0015;

/**
 * Largest canvas backing-store edge we will ask for.
 *
 * A renderbuffer bigger than the driver's limit does not fail politely — the context is
 * simply lost. 4096 is the smallest limit still in the wild, and on a 2x display a window
 * wider than 2048 CSS pixels crosses it, which is an ordinary maximised window.
 */
const MAX_BACKING_EDGE = 4096;

/** True when the page was opened with ?safe=1. */
const isSafeMode = () => new URLSearchParams(location.search).get('safe') === '1';

/** True when the page was opened with ?debug=1. Gates all diagnostic logging. */
const isDebug = () => new URLSearchParams(location.search).get('debug') === '1';

/** Diagnostic logging, silent unless ?debug=1. */
const debugLog = (...args: unknown[]) => {
  if (isDebug()) console.info('[coi-mapper]', ...args);
};

/** Device pixel ratio that keeps the backing store inside {@link MAX_BACKING_EDGE}. */
function safeResolution(width: number, height: number): number {
  if (isSafeMode()) return 1;
  const wanted = Math.min(window.devicePixelRatio || 1, 2);
  const longest = Math.max(width, height, 1);
  return Math.min(wanted, MAX_BACKING_EDGE / longest);
}
/** Fraction of the viewport the map occupies when fitted. */
const FIT_MARGIN = 0.96;

/** Zoom at which individual footprints get outlines drawn over the raster layer. */
export const OUTLINE_ZOOM = 6;

/**
 * Tile grid overlay, matched to the game's own terrain grid.
 *
 * Three nested levels: a line per tile, a stronger one every 16 tiles, and the heavy dark one
 * every 128 — eight 16-cells — so zooming into one 16-cell shows the 16x16 tiles inside it.
 *
 * The steps are fixed. Nothing scales them with the camera; instead each level fades on its
 * own on-screen spacing, dropping the tile lines first, then the 16s, leaving the 128s.
 */
const GRID_TILE_TILES = 1;
const GRID_MINOR_TILES = 16;
const GRID_MAJOR_TILES = 128;
/**
 * Where the heavy grid starts, in tiles, relative to tile (0,0).
 *
 * Zero: the grid is aligned to the map origin. Map sizes are whole multiples of 128 — 3584 is
 * 28 and 3840 is 30 — so the heavy lines meet the map edges exactly. An earlier build drew
 * this level every 96 tiles, which does not divide 3584, and the resulting drift looked like a
 * misplaced grid rather than a wrong step; the knob is kept so that is cheap to test again.
 *
 * If it ever is non-zero, note that a negative Y moves lines *down* the screen: the map is
 * drawn mirrored (see setZoom).
 */
const GRID_MAJOR_OFFSET_TILES = 0;
/** Each level fades in across this band of on-screen spacing, in pixels. */
const GRID_TILE_FADE_PX = { from: 6, to: 14 };
const GRID_MINOR_FADE_PX = { from: 9, to: 26 };
const GRID_COLOR = 0x000000;
const GRID_TILE_ALPHA = 0.16;
const GRID_MINOR_ALPHA = 0.4;
const GRID_MAJOR_ALPHA = 0.8;
/**
 * Heavy lines thin out as they crowd, rather than changing step or disappearing.
 *
 * On a 3584x3840 export the 128-tile lines land about 26px apart when the whole map is on
 * screen, and at full strength that is a black mesh over the entire base. Fading them keeps
 * the steps the game's while leaving the map readable at any zoom.
 */
const GRID_MAJOR_TIGHT_SPACING_PX = 20;
const GRID_MAJOR_CLEAR_SPACING_PX = 60;
const GRID_MAJOR_FAINT_ALPHA = 0.18;

const TRANSPORT_STYLE: Record<string, { color: number; width: number }> = {
  Conveyor: { color: 0xf0d878, width: 0.55 },
  Pipe: { color: 0x63c8e0, width: 0.55 },
  Unknown: { color: 0xcccccc, width: 0.45 },
};

/** One level of the grid: how often its lines fall, and where they start. */
interface GridLevel {
  step: number;
  offset: number;
}

export interface TileHit {
  tx: number;
  ty: number;
  /** Index into `doc.entities`, or -1 for bare terrain. */
  entityIndex: number;
}

/**
 * Logs renderer capabilities as soon as the context exists.
 *
 * This runs before anything that could hang or lose the context, so the numbers are in the
 * console either way — which the failure banner cannot promise, since a blocked main thread
 * never paints it.
 */
function logCapabilities(app: Application, canvas: HTMLCanvasElement, host: HTMLElement) {
  if (!isDebug()) return;
  try {
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    console.info('[coi-mapper] renderer:', {
      renderer: gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
      maxTexture: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbuffer: gl?.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      host: `${host.clientWidth}x${host.clientHeight}`,
      backing: `${canvas.width}x${canvas.height}`,
      resolution: app.renderer.resolution,
      dpr: window.devicePixelRatio,
    });
  } catch (err) {
    console.warn('[coi-mapper] renderer: capability query failed', err);
  }
}

export class MapScene {
  readonly app: Application;
  readonly canvas: HTMLCanvasElement;
  private readonly doc: WorkerDoc;
  private readonly host: HTMLElement;
  private readonly world = new Container();
  private readonly sprites = new Map<LayerName, Container>();
  private readonly grid = new Graphics();
  private readonly highlight = new Graphics();
  private observer: ResizeObserver | null = null;
  private pendingResize = 0;
  /** Size currently applied to the renderer, so repeat notifications are cheap no-ops. */
  private applied = { width: 0, height: 0 };
  private fitScale = 1;
  private fitted = false;
  /** Quarter turns clockwise applied to the view, 0-3. */
  private quarterTurns = 0;

  private constructor(app: Application, doc: WorkerDoc, host: HTMLElement, canvas: HTMLCanvasElement) {
    this.app = app;
    this.doc = doc;
    this.host = host;
    this.canvas = canvas;
  }

  /**
   * Builds a scene inside `host`, creating its own canvas.
   *
   * The canvas deliberately belongs to the scene rather than to React. A canvas element can
   * hold exactly one graphics context for its whole life, so reusing a React-owned one
   * across mounts hands the second scene a dead context — which is precisely what happens
   * under StrictMode in development, where every effect is mounted, torn down and mounted
   * again. Creating a fresh element per scene makes that sequence harmless.
   */
  static async create(host: HTMLElement, doc: WorkerDoc): Promise<MapScene> {
    const canvas = document.createElement('canvas');
    canvas.className = 'map-canvas';
    host.appendChild(canvas);

    const app = new Application();
    await app.init({
      canvas,
      // Sized explicitly and kept in sync by a ResizeObserver below. Pixi's own
      // `resizeTo` only listens for window resizes, so it would miss the stage
      // changing width when a side panel opens or closes.
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      backgroundColor: 0x0d1117,
      // No multisampling: it buys nothing on a nearest-neighbour tile raster, and on a
      // large canvas the multisampled backbuffer costs more memory than the map's textures.
      antialias: false,
      // Capped both by device ratio and by absolute backing size; see safeResolution.
      resolution: safeResolution(host.clientWidth, host.clientHeight),
      autoDensity: true,
      // WebGL by default. ?renderer=webgpu switches backend, which is worth trying when
      // the drawing buffer is demonstrably correct but nothing reaches the screen —
      // that points at the platform's WebGL compositing path rather than at our scene.
      preference: new URLSearchParams(location.search).get('renderer') === 'webgpu' ? 'webgpu' : 'webgl',
    });
    debugLog(`scene: renderer backend = ${app.renderer.type === 1 ? 'webgl' : 'webgpu'}`);

    logCapabilities(app, canvas, host);

    const scene = new MapScene(app, doc, host, canvas);
    scene.build();

    scene.observeHost();
    // Fit immediately when the host is already laid out, rather than relying on the
    // observer to deliver the first notification. Making the initial fit depend on that
    // callback meant any hiccup in it left the world unpositioned — at scale 1 over the
    // map's top-left corner, which on an ocean-cornered map looks like a black screen.
    if (host.clientWidth >= 1 && host.clientHeight >= 1) {
      scene.applySize(host.clientWidth, host.clientHeight);
    } else {
      console.info('[coi-mapper] scene: host has no size yet; waiting for the observer');
    }
    return scene;
  }

  // Note: the layers' source ImageBitmaps are deliberately NOT closed after upload.
  //
  // Doing so looks like an easy way to halve GPU memory, since Chrome backs ImageBitmap
  // with GPU memory and Pixi allocates its own texture from each. But Pixi uploads lazily,
  // on the first frame that actually draws a sprite — and the initial fit happens in a
  // ResizeObserver callback, which runs after this constructor returns. Closing the
  // sources before that first real frame leaves every texture permanently unuploadable,
  // and Pixi then retries forever: a black canvas pinned at 100% CPU.
  //
  // The texture budget in the loader keeps the doubled footprint affordable instead.

  /** Keeps the renderer matched to its container, preserving the centred world point. */
  private observeHost() {
    this.observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return;

      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      // Ignore notifications that do not actually change the size. Resizing the renderer
      // rewrites the canvas's inline width and height, which is itself a layout change and
      // can bring us straight back here; without this guard that is an endless cycle.
      if (width === this.applied.width && height === this.applied.height) return;

      // Defer the work out of the observer callback for the same reason: never mutate
      // layout synchronously inside one.
      cancelAnimationFrame(this.pendingResize);
      this.pendingResize = requestAnimationFrame(() => this.applySize(width, height));
    });
    this.observer.observe(this.host);
  }

  /**
   * Reports what the renderer actually produced.
   *
   * "Nothing visible" has several very different causes — textures that never uploaded,
   * sprites sized or positioned outside the view, or a draw that happened but produced the
   * clear colour. This distinguishes them by reading pixels back straight after a render,
   * before the drawing buffer is swapped.
   */
  private logRenderState() {
    if (!isDebug()) return;
    try {
      const layers: Record<string, unknown> = {};
      for (const [name, container] of this.sprites) {
        if (!(container instanceof Container) || container.children.length === 0) continue;
        const first = container.children[0] as Sprite;
        const bounds = container.getBounds();
        layers[name] = {
          children: container.children.length,
          visible: container.visible,
          texture: first?.texture ? `${first.texture.width}x${first.texture.height}` : 'none',
          spriteSize: first ? `${first.width}x${first.height}` : 'none',
          screenBounds: `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)}`,
        };
      }

      this.app.render();

      // Sample the middle of the canvas immediately after rendering: the drawing buffer is
      // still intact within this task, so a uniform result means nothing was drawn there.
      let sample = 'unavailable';
      const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
      if (gl) {
        const size = 32;
        const px = new Uint8Array(size * size * 4);
        const cx = Math.max(0, Math.floor((this.app.renderer.width - size) / 2));
        const cy = Math.max(0, Math.floor((this.app.renderer.height - size) / 2));
        gl.readPixels(cx, cy, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const seen = new Set<number>();
        for (let i = 0; i < px.length; i += 4) seen.add((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
        const first = [...seen].slice(0, 3).map((c) => `#${c.toString(16).padStart(6, '0')}`);
        sample = `${seen.size} distinct colours ${first.join(' ')}`;
      }

      // Flattened to plain lines: nested objects are collapsed by most console capture,
      // and a flat log is easier to copy out of DevTools when reporting a problem.
      const lines = [
        `renderer type ${this.app.renderer.type}, canvas ${this.app.renderer.width}x${this.app.renderer.height}`,
        `world scale ${this.world.scale.x.toFixed(4)} at ${Math.round(this.world.x)},${Math.round(this.world.y)}, ` +
          `${this.app.stage.children.length} stage children`,
        `centre sample: ${sample}`,
      ];
      for (const [name, info] of Object.entries(layers)) {
        lines.push(`layer ${name}: ${JSON.stringify(info)}`);
      }
      for (const line of lines) debugLog(`draw: ${line}`);
      this.logPresentation();
    } catch (err) {
      console.warn('[coi-mapper] draw: state query failed', err);
    }
  }

  /**
   * Reports whether the canvas is actually on screen.
   *
   * A correct frame in the drawing buffer still shows nothing if the canvas is hidden,
   * zero-sized, covered by another element, or never presented because the ticker is not
   * running. Those are invisible to any check that only inspects the renderer.
   */
  private logPresentation() {
    if (!isDebug()) return;
    try {
      const canvas = this.app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);

      console.info(
        `[coi-mapper] present: rect ${Math.round(rect.width)}x${Math.round(rect.height)} at ` +
          `${Math.round(rect.left)},${Math.round(rect.top)}; display=${style.display} ` +
          `visibility=${style.visibility} opacity=${style.opacity} zIndex=${style.zIndex} ` +
          `transform=${style.transform}`,
      );

      // What the browser thinks is on top at the canvas's centre. Anything other than the
      // canvas itself is covering the map.
      const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const describe = (el: Element | null) =>
        el ? `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}` : 'nothing';
      debugLog(`present: topmost element at canvas centre is ${describe(topmost)}`);

      // Is the render loop actually producing frames, or did only the manual render run?
      let frames = 0;
      const count = () => { frames++; };
      this.app.ticker.add(count);
      setTimeout(() => {
        // The scene may already have been destroyed — StrictMode tears one down within
        // milliseconds — in which case the ticker is gone and there is nothing to report.
        const ticker = this.app?.ticker;
        if (!ticker) return;
        ticker.remove(count);
        debugLog(`present: ticker started=${ticker.started}, ${frames} frames in 1s`);
      }, 1000);
    } catch (err) {
      console.warn('[coi-mapper] present: query failed', err);
    }
  }

  /** Matches the renderer to a new host size, preserving the centred world point. */
  private applySize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    this.applied = { width, height };

    const before = this.app.screen;
    const centre = this.screenToWorld(before.width / 2, before.height / 2);
    // Recompute the resolution too: growing the window can otherwise push the backing
    // store past the driver's renderbuffer limit and drop the context.
    this.app.renderer.resize(width, height, safeResolution(width, height));

    if (!this.fitted) {
      this.fitted = true;
      this.fitToMap();
      debugLog(`scene: fitted at zoom ${this.zoom.toFixed(4)} — map is live`);
      this.logRenderState();
      return;
    }
    // Afterwards, hold the centred world point steady so opening a panel does not
    // appear to shove the map sideways.
    this.fitScale = this.computeFitScale();
    this.placeWorldPointAt(centre.x, centre.y, width / 2, height / 2);
    this.cameraChanged();
  }

  private build() {
    const { layers } = this.doc;

    // Raster layers, bottom to top. Entities sit under the network overlays so belts
    // and power lines stay visible where they cross a building.
    //
    // A layer is skipped entirely when the export carried no plane for it. Each one is
    // width*height*4 bytes of texture — 55 MB on a 13.8M-tile map — so uploading empty
    // overlays can exhaust GPU memory and leave nothing on screen at all.
    for (const name of ['terrain', 'deposits', 'designations', 'entities'] as const) {
      const chunks = layers[name];
      if (chunks && chunks.length > 0) {
        // One container per layer holding a sprite per chunk, so toggling still works on
        // the layer as a whole.
        const container = new Container();
        for (const chunk of chunks) {
          const texture = Texture.from(chunk.bitmap);
          // Nearest-neighbour keeps tile edges crisp instead of smearing when zoomed in.
          texture.source.scaleMode = 'nearest';
          const sprite = new Sprite(texture);
          sprite.position.set(chunk.x, chunk.y);
          sprite.width = chunk.w;
          sprite.height = chunk.h;
          container.addChild(sprite);
        }
        this.sprites.set(name, container);
        this.world.addChild(container);
        debugLog(`scene: uploaded layer "${name}" (${chunks.length} chunks)`);
      }
      if (name === 'entities') this.world.addChild(this.buildTransports(), this.buildPower());
    }

    if (new URLSearchParams(location.search).get('debug') === '1') {
      // A texture-free shape covering the map. If this is visible but the layers are not,
      // the camera is fine and the problem is in the textures.
      const { width, height } = this.doc.manifest.map;
      const probe = new Graphics()
        .rect(0, 0, width, height)
        .fill({ color: 0xff00ff, alpha: 0.35 })
        .stroke({ width: Math.max(2, width / 200), color: 0x00ffff });
      this.world.addChildAt(probe, 0);
      console.info('[coi-mapper] debug: vector probe added over the map bounds');
    }

    // The grid sits over the data layers, as it does in the game, so you can see how a
    // building straddles a cell. The highlight goes above it so selection stays legible.
    this.sprites.set('grid', this.grid);
    this.world.addChild(this.grid);
    this.world.addChild(this.highlight);
    this.app.stage.addChild(this.world);
  }

  private buildTransports(): Graphics {
    const g = new Graphics();
    for (const t of this.doc.transports) {
      const pts = t.points;
      if (pts.length < 4) continue;
      g.moveTo(pts[0]! + 0.5, pts[1]! + 0.5);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]! + 0.5, pts[i + 1]! + 0.5);
      const style = TRANSPORT_STYLE[t.kind] ?? TRANSPORT_STYLE.Unknown!;
      g.stroke({ width: style.width, color: style.color, alpha: 0.95, cap: 'round', join: 'round' });
    }
    this.sprites.set('transports', g);
    return g;
  }

  private buildPower(): Graphics {
    const g = new Graphics();
    const byId = new Map<number, Entity>(this.doc.entities.map((e) => [e.id, e]));
    const center = (e: Entity) => [e.x + e.w / 2, e.y + e.h / 2] as const;

    for (const edge of this.doc.edges) {
      const a = byId.get(edge.a);
      const b = byId.get(edge.b);
      if (!a || !b) continue;
      const [ax, ay] = center(a);
      const [bx, by] = center(b);
      g.moveTo(ax, ay).lineTo(bx, by);
    }
    g.stroke({ width: 0.28, color: 0xffd76a, alpha: 0.5 });
    this.sprites.set('power', g);
    return g;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  get zoom(): number {
    return this.world.scale.x;
  }

  /**
   * Sets the camera scale, mirroring the world vertically as it goes.
   *
   * The game's tile Y counts northward, while a raster's rows count downward, so drawing
   * row 0 at the top of the screen lays the map out back to front. Mirroring the container
   * rather than the data means terrain, buildings and overlays all flip together, picking
   * keeps working through the same inverse, and the tile coordinates we report stay the
   * ones the game itself would show for that spot.
   */
  private setZoom(z: number) {
    this.world.scale.set(z, -z);
  }

  /** True on an odd quarter turn, where the map's on-screen axes are swapped. */
  private get quarterTurned(): boolean {
    return this.quarterTurns % 2 === 1;
  }

  /**
   * Screen pixels to world tiles, through the whole camera transform.
   *
   * Every inverse in this file goes through here rather than undoing the offset and scale
   * by hand. A hand-rolled inverse silently stops being right the moment the camera gains
   * a rotation, and the symptom — picking the wrong building — looks plausible.
   */
  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.world.toLocal({ x: sx, y: sy });
  }

  /** Moves the camera so that world point (wx, wy) sits at screen point (sx, sy). */
  private placeWorldPointAt(wx: number, wy: number, sx: number, sy: number) {
    // With the offset zeroed, toGlobal gives the rotate-and-scale part on its own, which
    // is exactly the amount that has to be cancelled to land the point where we want it.
    this.world.position.set(0, 0);
    const p = this.world.toGlobal({ x: wx, y: wy });
    this.world.position.set(sx - p.x, sy - p.y);
  }

  /** The map's extent in tiles as it lies on screen, so axes swap on an odd turn. */
  private screenExtent(): { w: number; h: number } {
    const { width, height } = this.doc.manifest.map;
    return this.quarterTurned ? { w: height, h: width } : { w: width, h: height };
  }

  private computeFitScale(): number {
    const { w, h } = this.screenExtent();
    const { width: sw, height: sh } = this.app.screen;
    return Math.min(sw / w, sh / h) * FIT_MARGIN;
  }

  fitToMap() {
    const { width, height } = this.doc.manifest.map;
    const { width: sw, height: sh } = this.app.screen;
    this.fitScale = this.computeFitScale();
    this.setZoom(this.fitScale);
    this.placeWorldPointAt(width / 2, height / 2, sw / 2, sh / 2);
    this.cameraChanged();
  }

  /**
   * Turns the view a quarter turn: +1 clockwise, -1 anticlockwise.
   *
   * Only the container turns. Rotating the data would mean re-baking every terrain chunk
   * and rebuilding the tile index on each press, so orientation stays a camera property
   * and tile coordinates remain in unrotated map space everywhere else.
   */
  rotateBy(turns: number) {
    const { width: sw, height: sh } = this.app.screen;
    // Pin whatever is being looked at, so the map turns about the middle of the view
    // rather than about tile (0,0), which is where Pixi would otherwise swing it.
    const centre = this.screenToWorld(sw / 2, sh / 2);

    this.quarterTurns = (this.quarterTurns + turns + 4) % 4;
    this.world.rotation = (this.quarterTurns * Math.PI) / 2;

    // The fit scale doubles as the zoom-out floor and depends on which way round the map
    // lies, so on a non-square map a turn can leave the camera below the new minimum.
    this.fitScale = this.computeFitScale();
    const min = this.fitScale * MIN_ZOOM_FACTOR;
    if (this.zoom < min) this.setZoom(min);

    this.placeWorldPointAt(centre.x, centre.y, sw / 2, sh / 2);
    this.cameraChanged();
  }

  /**
   * Re-renders whatever depends on the camera rather than on the data.
   *
   * Every mutator below routes through here, so anything camera-derived — currently the
   * data attributes and the grid — cannot be left stale by a new movement path.
   */
  private cameraChanged() {
    this.publishCamera();
    this.drawGrid();
  }

  /** Mirrors camera state onto the canvas as data attributes, for tests and debugging. */
  private publishCamera() {
    const canvas = this.app.canvas as HTMLCanvasElement;
    const { w, h } = this.screenExtent();
    canvas.dataset.zoom = this.zoom.toFixed(4);
    // Reported as the map lies on screen, so a fit assertion still means something once
    // the view has been turned.
    canvas.dataset.mapSpan = `${(w * this.zoom).toFixed(0)}x${(h * this.zoom).toFixed(0)}`;
    canvas.dataset.rotation = String(this.quarterTurns * 90);
  }

  panBy(dx: number, dy: number) {
    this.world.position.set(this.world.x + dx, this.world.y + dy);
    this.cameraChanged();
  }

  /** Zooms about a screen point, keeping the world point under the cursor fixed. */
  zoomAt(screenX: number, screenY: number, deltaY: number) {
    const min = this.fitScale * MIN_ZOOM_FACTOR;
    const next = Math.min(MAX_ZOOM, Math.max(min, this.zoom * ZOOM_PER_WHEEL_LINE ** -deltaY));
    if (next === this.zoom) return;

    const w = this.screenToWorld(screenX, screenY);
    this.setZoom(next);
    this.placeWorldPointAt(w.x, w.y, screenX, screenY);
    this.cameraChanged();
  }

  /** Centres the view on a tile without changing zoom. */
  centerOn(tx: number, ty: number) {
    const { width: sw, height: sh } = this.app.screen;
    this.placeWorldPointAt(tx + 0.5, ty + 0.5, sw / 2, sh / 2);
    this.cameraChanged();
  }

  // ── picking ───────────────────────────────────────────────────────────────
  /** Resolves a screen position to a tile and whatever entity occupies it. */
  hitTest(screenX: number, screenY: number): TileHit | null {
    const { width, height } = this.doc.manifest.map;
    const p = this.screenToWorld(screenX, screenY);
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
    return { tx, ty, entityIndex: this.doc.tileToEntity[ty * width + tx]! };
  }

  // ── grid ──────────────────────────────────────────────────────────────────
  /**
   * Redraws the tile grid for the current camera.
   *
   * Only the lines inside the viewport are emitted. Spanning the whole map would be
   * thousands of segments on a large export — 7,400 on a 3584x3840 one — where culling
   * to the viewport caps it in the low hundreds, cheap enough to redraw on every pan.
   */
  private drawGrid() {
    const g = this.grid;
    const canvas = this.app.canvas as HTMLCanvasElement;
    g.clear();
    if (!g.visible) {
      canvas.dataset.gridStep = 'off';
      return;
    }

    const { width: mapW, height: mapH } = this.doc.manifest.map;
    const { width: sw, height: sh } = this.app.screen;
    const zoom = this.zoom;

    // The visible world rect, clamped to the map. Lines outside it cost the same to
    // draw as lines inside it and are never seen.
    // Taking the bounding box of the viewport's corners keeps this right under rotation,
    // and at exact quarter turns the box is tight, so nothing extra gets drawn.
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(sw, 0),
      this.screenToWorld(0, sh),
      this.screenToWorld(sw, sh),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const x1 = Math.min(mapW, Math.ceil(Math.max(...xs)));
    const y1 = Math.min(mapH, Math.ceil(Math.max(...ys)));
    if (!(x1 > x0 && y1 > y0)) {
      canvas.dataset.gridStep = 'off';
      return;
    }

    // Stroke widths are world units, so divide by zoom to pin them to screen pixels.
    const px = 1 / zoom;

    // Each level fades on its own on-screen spacing rather than on zoom: spacing is what
    // decides whether lines read as a grid or as a grey wash, and the same zoom means very
    // different spacing at each step.
    const fade = (spacing: number, band: { from: number; to: number }) =>
      Math.max(0, Math.min(1, (spacing - band.from) / (band.to - band.from)));

    const tileAlpha = GRID_TILE_ALPHA * fade(zoom, GRID_TILE_FADE_PX);
    const minorAlpha = GRID_MINOR_ALPHA * fade(GRID_MINOR_TILES * zoom, GRID_MINOR_FADE_PX);

    const tiles = { step: GRID_TILE_TILES, offset: 0 };
    const minor = { step: GRID_MINOR_TILES, offset: 0 };
    const major = { step: GRID_MAJOR_TILES, offset: GRID_MAJOR_OFFSET_TILES };

    // Every level skips the lines the level above already owns, so a shared line is drawn
    // once at its strongest weight instead of being painted over.
    if (tileAlpha > 0.01) this.strokeGridLines(tiles, minor, x0, y0, x1, y1, px, tileAlpha);
    if (minorAlpha > 0.01) this.strokeGridLines(minor, major, x0, y0, x1, y1, px, minorAlpha);

    const majorRamp = Math.max(0, Math.min(1,
      (GRID_MAJOR_TILES * zoom - GRID_MAJOR_TIGHT_SPACING_PX)
      / (GRID_MAJOR_CLEAR_SPACING_PX - GRID_MAJOR_TIGHT_SPACING_PX)));
    this.strokeGridLines(major, null, x0, y0, x1, y1, 2 * px,
      GRID_MAJOR_FAINT_ALPHA + (GRID_MAJOR_ALPHA - GRID_MAJOR_FAINT_ALPHA) * majorRamp);

    // The finest level actually on screen, so a test can tell the states apart.
    const finest = tileAlpha > 0.01 ? GRID_TILE_TILES
      : minorAlpha > 0.01 ? GRID_MINOR_TILES : GRID_MAJOR_TILES;
    canvas.dataset.gridStep = String(finest);
  }

  /**
   * Strokes one level of the grid across the visible rect.
   *
   * `owner` is the level above, whose lines this one leaves alone: a line belonging to the
   * heavy pass drawn twice would darken unevenly rather than cleanly. Both levels carry an
   * offset so the grid can be shifted off the map origin without the ownership test drifting
   * out of step with what is actually drawn.
   */
  private strokeGridLines(
    level: GridLevel, owner: GridLevel | null,
    x0: number, y0: number, x1: number, y1: number,
    width: number, alpha: number,
  ) {
    const g = this.grid;
    // First line of `level` at or after `v0`, and whether `v` is one of `owner`'s.
    const start = (v0: number) =>
      Math.ceil((v0 - level.offset) / level.step) * level.step + level.offset;
    const ownedBy = (v: number) =>
      owner !== null && (((v - owner.offset) % owner.step) + owner.step) % owner.step === 0;

    for (let x = start(x0); x <= x1; x += level.step) {
      if (ownedBy(x)) continue;
      g.moveTo(x, y0);
      g.lineTo(x, y1);
    }
    for (let y = start(y0); y <= y1; y += level.step) {
      if (ownedBy(y)) continue;
      g.moveTo(x0, y);
      g.lineTo(x1, y);
    }
    g.stroke({ width, color: GRID_COLOR, alpha, alignment: 0.5 });
  }

  // ── layers & highlight ────────────────────────────────────────────────────
  setLayerVisible(name: LayerName, visible: boolean) {
    const layer = this.sprites.get(name);
    if (!layer) return;
    layer.visible = visible;
    // The grid is drawn for the camera it was last shown at, and drawGrid() skips a
    // hidden grid entirely, so a visibility flip has to be followed by a redraw.
    if (name === 'grid') this.drawGrid();
  }

  /** Draws the hover and selection outlines. Pass -1 for none. */
  setHighlight(hovered: number, selected: number) {
    const g = this.highlight;
    g.clear();
    // Outline width is in world units, so divide by zoom to keep it constant on screen.
    const px = 1 / this.zoom;

    const draw = (index: number, color: number, widthPx: number, fillAlpha: number) => {
      const e = this.doc.entities[index];
      if (!e) return;

      if (hasSparseFootprint(e)) {
        // A snaking conveyor's bounding box is mostly empty, so outlining it would flash a
        // huge rectangle over unrelated machines. Trace the tiles it actually covers.
        const tiles = e.tiles!;
        for (let i = 0; i + 1 < tiles.length; i += 2) {
          g.rect(e.x + tiles[i]!, e.y + tiles[i + 1]!, 1, 1);
        }
      } else {
        g.rect(e.x, e.y, e.w, e.h);
      }

      if (fillAlpha > 0) g.fill({ color, alpha: fillAlpha });
      g.stroke({ width: widthPx * px, color, alpha: 0.95, alignment: 0.5 });
    };

    if (hovered >= 0 && hovered !== selected) draw(hovered, 0xffffff, 1.5, 0.12);
    if (selected >= 0) draw(selected, 0x4fc3f7, 2.5, 0.2);
  }

  destroy() {
    cancelAnimationFrame(this.pendingResize);
    this.observer?.disconnect();
    this.observer = null;
    this.app.destroy({ removeView: true }, { children: true, texture: true });
    // Belt and braces: the canvas must not outlive its context, or a later scene could
    // find it still attached and inherit a dead one.
    this.canvas.remove();
  }
}
