/**
 * PixiJS scene for the map: layer sprites, vector overlays, and a pan/zoom camera.
 *
 * The world is measured in tiles — one world unit per tile — so camera scale reads
 * directly as "screen pixels per tile", which is what the zoom UI and the
 * label/outline thresholds care about.
 *
 * The scene owns the camera and the layer registry; the drawing lives beside it — the grid
 * in `grid.ts`, zones, transports, power and the highlight in `overlays.ts`, raster chunk
 * sprites in `layers.ts`, and the `?debug=1` logging in `diagnostics.ts`. Those modules
 * take world rects and a zoom, never screen positions: converting between the two stays
 * here, in `screenToWorld` and `placeWorldPointAt`, so rotation cannot be got wrong twice.
 */
import { Application, Container, Graphics } from 'pixi.js';
import type { LayerChunk, LayerName, WorkerDoc } from '../coimap/types';
import { stackAt } from '../coimap/stack';
import { addDebugProbe, debugLog, logCapabilities, logRenderState, safeResolution } from './diagnostics';
import { drawGrid } from './grid';
import type { TileRect } from './grid';
import { addChunkSprites, replaceChunkSprites } from './layers';
import { buildPower, buildTransports, drawHighlight, drawZones } from './overlays';

const MAX_ZOOM = 48;         // screen pixels per tile
const MIN_ZOOM_FACTOR = 0.6; // relative to the fit-to-screen scale
const ZOOM_PER_WHEEL_LINE = 1.0015;

/** Fraction of the viewport the map occupies when fitted. */
const FIT_MARGIN = 0.96;

/** Zoom at which individual footprints get outlines drawn over the raster layer. */
export const OUTLINE_ZOOM = 6;

export interface TileHit {
  tx: number;
  ty: number;
  /** Index into `doc.entities` of the topmost occupant, or -1 for bare terrain. */
  entityIndex: number;
  /** Everything on the tile, topmost first — more than one where a pipe runs under a belt. */
  stack: number[];
}

export class MapScene {
  readonly app: Application;
  readonly canvas: HTMLCanvasElement;
  private readonly doc: WorkerDoc;
  private readonly host: HTMLElement;
  private readonly world = new Container();
  private readonly sprites = new Map<LayerName, Container>();
  private readonly grid = new Graphics();
  private readonly zones = new Graphics();
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
      logRenderState(this.app, this.world, this.sprites);
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
    for (const name of ['terrain', 'surfaces', 'deposits', 'designations', 'entities'] as const) {
      const chunks = layers[name];
      if (chunks && chunks.length > 0) {
        // One container per layer holding a sprite per chunk, so toggling still works on
        // the layer as a whole.
        const container = new Container();
        addChunkSprites(container, chunks);
        this.sprites.set(name, container);
        this.world.addChild(container);
        debugLog(`scene: uploaded layer "${name}" (${chunks.length} chunks)`);
      }
      if (name === 'entities') {
        // Zones go under the transport and power lines: they are an area wash, and a wash
        // painted over a 0.28-tile conveyor line is what makes one hard to follow.
        const transports = buildTransports(this.doc.transports);
        const power = buildPower(this.doc.entities, this.doc.edges);
        this.sprites.set('zones', this.zones);
        this.sprites.set('transports', transports);
        this.sprites.set('power', power);
        this.world.addChild(this.zones, transports, power);
      }
    }

    addDebugProbe(this.world, this.doc.manifest.map.width, this.doc.manifest.map.height);

    // The grid sits over the data layers, as it does in the game, so you can see how a
    // building straddles a cell. The highlight goes above it so selection stays legible.
    this.sprites.set('grid', this.grid);
    this.world.addChild(this.grid);
    this.world.addChild(this.highlight);
    this.app.stage.addChild(this.world);
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
    this.drawZones();
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
  /** Resolves a screen position to a tile and whatever entities occupy it. */
  hitTest(screenX: number, screenY: number): TileHit | null {
    const { width, height } = this.doc.manifest.map;
    const p = this.screenToWorld(screenX, screenY);
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
    const stack = stackAt(this.doc, ty * width + tx);
    return { tx, ty, entityIndex: stack[0] ?? -1, stack };
  }

  // ── camera-drawn overlays ─────────────────────────────────────────────────
  /**
   * The whole tiles on screen, clamped to the map, or null when none are.
   *
   * The bounding box of the viewport's corners, which keeps it right under rotation; at
   * exact quarter turns the box is tight, so nothing extra gets drawn.
   */
  private visibleTiles(): TileRect | null {
    const { width: mapW, height: mapH } = this.doc.manifest.map;
    const { width: sw, height: sh } = this.app.screen;
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(sw, 0),
      this.screenToWorld(0, sh),
      this.screenToWorld(sw, sh),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const rect = {
      x0: Math.max(0, Math.floor(Math.min(...xs))),
      y0: Math.max(0, Math.floor(Math.min(...ys))),
      x1: Math.min(mapW, Math.ceil(Math.max(...xs))),
      y1: Math.min(mapH, Math.ceil(Math.max(...ys))),
    };
    return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null;
  }

  /** Redraws the tile grid for the current camera, and reports its finest step. */
  private drawGrid() {
    const g = this.grid;
    const canvas = this.app.canvas as HTMLCanvasElement;
    g.clear();
    // Culled to the viewport, so it is drawn for one camera and skipped while hidden.
    const view = g.visible ? this.visibleTiles() : null;
    canvas.dataset.gridStep = view ? drawGrid(g, view, this.zoom) : 'off';
  }

  /** Redraws the zones, whose outline width is pinned to screen pixels. */
  private drawZones() {
    this.zones.clear();
    if (this.zones.visible) drawZones(this.zones, this.doc.manifest.zones, this.zoom);
  }

  // ── layers & highlight ────────────────────────────────────────────────────
  /** Swaps a raster layer's pixels for a re-baked set; see `replaceChunkSprites`. */
  replaceLayer(name: 'entities', chunks: LayerChunk[]) {
    const container = this.sprites.get(name);
    if (container) replaceChunkSprites(container, chunks);
  }

  setLayerVisible(name: LayerName, visible: boolean) {
    const layer = this.sprites.get(name);
    if (!layer) return;
    layer.visible = visible;
    // Both are drawn for the camera they were last shown at, and both skip the work
    // entirely while hidden, so a visibility flip has to be followed by a redraw.
    if (name === 'grid') this.drawGrid();
    if (name === 'zones') this.drawZones();
  }

  /** Draws the hover and selection outlines. Pass -1 for none. */
  setHighlight(hovered: number, selected: number) {
    drawHighlight(this.highlight, this.doc.entities, hovered, selected, this.zoom);
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
