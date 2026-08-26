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

const TRANSPORT_STYLE: Record<string, { color: number; width: number }> = {
  Conveyor: { color: 0xf0d878, width: 0.55 },
  Pipe: { color: 0x63c8e0, width: 0.55 },
  Unknown: { color: 0xcccccc, width: 0.45 },
};

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
  private readonly doc: WorkerDoc;
  private readonly host: HTMLElement;
  private readonly world = new Container();
  private readonly sprites = new Map<LayerName, Container>();
  private readonly highlight = new Graphics();
  private observer: ResizeObserver | null = null;
  private pendingResize = 0;
  /** Size currently applied to the renderer, so repeat notifications are cheap no-ops. */
  private applied = { width: 0, height: 0 };
  private fitScale = 1;
  private fitted = false;

  private constructor(app: Application, doc: WorkerDoc, host: HTMLElement) {
    this.app = app;
    this.doc = doc;
    this.host = host;
  }

  static async create(canvas: HTMLCanvasElement, doc: WorkerDoc): Promise<MapScene> {
    const host = canvas.parentElement;
    if (!host) throw new Error('Map canvas must be mounted before the scene is created.');

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
      preference: 'webgl',
    });

    logCapabilities(app, canvas, host);

    const scene = new MapScene(app, doc, host);
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
      for (const line of lines) console.info(`[coi-mapper] draw: ${line}`);
    } catch (err) {
      console.warn('[coi-mapper] draw: state query failed', err);
    }
  }

  /** Matches the renderer to a new host size, preserving the centred world point. */
  private applySize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    this.applied = { width, height };

    const before = this.app.screen;
    const centre = {
      x: (before.width / 2 - this.world.x) / this.zoom,
      y: (before.height / 2 - this.world.y) / this.zoom,
    };
    // Recompute the resolution too: growing the window can otherwise push the backing
    // store past the driver's renderbuffer limit and drop the context.
    this.app.renderer.resize(width, height, safeResolution(width, height));

    if (!this.fitted) {
      this.fitted = true;
      this.fitToMap();
      console.info(`[coi-mapper] scene: fitted at zoom ${this.zoom.toFixed(4)} — map is live`);
      this.logRenderState();
      return;
    }
    // Afterwards, hold the centred world point steady so opening a panel does not
    // appear to shove the map sideways.
    this.fitScale = this.computeFitScale();
    this.world.position.set(width / 2 - centre.x * this.zoom, height / 2 - centre.y * this.zoom);
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
        console.info(`[coi-mapper] scene: uploaded layer "${name}" (${chunks.length} chunks)`);
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

  private computeFitScale(): number {
    const { width, height } = this.doc.manifest.map;
    const { width: sw, height: sh } = this.app.screen;
    return Math.min(sw / width, sh / height) * FIT_MARGIN;
  }

  fitToMap() {
    const { width, height } = this.doc.manifest.map;
    const { width: sw, height: sh } = this.app.screen;
    this.fitScale = this.computeFitScale();
    this.world.scale.set(this.fitScale);
    this.world.position.set((sw - width * this.fitScale) / 2, (sh - height * this.fitScale) / 2);
    this.publishCamera();
  }

  /** Mirrors camera state onto the canvas as data attributes, for tests and debugging. */
  private publishCamera() {
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.dataset.zoom = this.zoom.toFixed(4);
    canvas.dataset.mapSpan = `${(this.doc.manifest.map.width * this.zoom).toFixed(0)}x${(this.doc.manifest.map.height * this.zoom).toFixed(0)}`;
  }

  panBy(dx: number, dy: number) {
    this.world.position.set(this.world.x + dx, this.world.y + dy);
  }

  /** Zooms about a screen point, keeping the world point under the cursor fixed. */
  zoomAt(screenX: number, screenY: number, deltaY: number) {
    const min = this.fitScale * MIN_ZOOM_FACTOR;
    const next = Math.min(MAX_ZOOM, Math.max(min, this.zoom * ZOOM_PER_WHEEL_LINE ** -deltaY));
    if (next === this.zoom) return;

    const wx = (screenX - this.world.x) / this.zoom;
    const wy = (screenY - this.world.y) / this.zoom;
    this.world.scale.set(next);
    this.world.position.set(screenX - wx * next, screenY - wy * next);
    this.publishCamera();
  }

  /** Centres the view on a tile without changing zoom. */
  centerOn(tx: number, ty: number) {
    const { width: sw, height: sh } = this.app.screen;
    this.world.position.set(sw / 2 - (tx + 0.5) * this.zoom, sh / 2 - (ty + 0.5) * this.zoom);
  }

  // ── picking ───────────────────────────────────────────────────────────────
  /** Resolves a screen position to a tile and whatever entity occupies it. */
  hitTest(screenX: number, screenY: number): TileHit | null {
    const { width, height } = this.doc.manifest.map;
    const tx = Math.floor((screenX - this.world.x) / this.zoom);
    const ty = Math.floor((screenY - this.world.y) / this.zoom);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
    return { tx, ty, entityIndex: this.doc.tileToEntity[ty * width + tx]! };
  }

  // ── layers & highlight ────────────────────────────────────────────────────
  setLayerVisible(name: LayerName, visible: boolean) {
    const layer = this.sprites.get(name);
    if (layer) layer.visible = visible;
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
    this.app.destroy(true, { children: true, texture: true });
  }
}
