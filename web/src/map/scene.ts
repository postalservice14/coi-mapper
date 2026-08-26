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

const MAX_ZOOM = 48;         // screen pixels per tile
const MIN_ZOOM_FACTOR = 0.6; // relative to the fit-to-screen scale
const ZOOM_PER_WHEEL_LINE = 1.0015;
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

export class MapScene {
  readonly app: Application;
  private readonly doc: WorkerDoc;
  private readonly host: HTMLElement;
  private readonly world = new Container();
  private readonly sprites = new Map<LayerName, Container>();
  private readonly highlight = new Graphics();
  private observer: ResizeObserver | null = null;
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
      antialias: true,
      resolution: window.devicePixelRatio,
      autoDensity: true,
      preference: 'webgl',
    });

    const scene = new MapScene(app, doc, host);
    scene.build();
    // No fit here: the element may not have its final size yet. ResizeObserver fires
    // once as soon as it starts observing, and that callback performs the initial fit
    // against the settled layout.
    scene.observeHost();
    return scene;
  }

  /** Keeps the renderer matched to its container, preserving the centred world point. */
  private observeHost() {
    this.observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return;

      const before = this.app.screen;
      const centre = {
        x: (before.width / 2 - this.world.x) / this.zoom,
        y: (before.height / 2 - this.world.y) / this.zoom,
      };
      this.app.renderer.resize(rect.width, rect.height);

      if (!this.fitted) {
        this.fitted = true;
        this.fitToMap();
        return;
      }
      // Afterwards, hold the centred world point steady so opening a panel does not
      // appear to shove the map sideways.
      this.fitScale = this.computeFitScale();
      this.world.position.set(rect.width / 2 - centre.x * this.zoom, rect.height / 2 - centre.y * this.zoom);
    });
    this.observer.observe(this.host);
  }

  private build() {
    const { layers } = this.doc;

    // Raster layers, bottom to top. Entities sit under the network overlays so belts
    // and power lines stay visible where they cross a building.
    for (const name of ['terrain', 'deposits', 'designations', 'entities'] as const) {
      const texture = Texture.from(layers[name]);
      // Nearest-neighbour keeps tile edges crisp instead of smearing when zoomed in.
      texture.source.scaleMode = 'nearest';
      const sprite = new Sprite(texture);
      sprite.width = this.doc.manifest.map.width;
      sprite.height = this.doc.manifest.map.height;
      this.sprites.set(name, sprite);
      this.world.addChild(sprite);
      if (name === 'entities') this.world.addChild(this.buildTransports(), this.buildPower());
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
      g.rect(e.x, e.y, e.w, e.h);
      if (fillAlpha > 0) g.fill({ color, alpha: fillAlpha });
      g.stroke({ width: widthPx * px, color, alpha: 0.95, alignment: 0.5 });
    };

    if (hovered >= 0 && hovered !== selected) draw(hovered, 0xffffff, 1.5, 0.12);
    if (selected >= 0) draw(selected, 0x4fc3f7, 2.5, 0.2);
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.app.destroy(true, { children: true, texture: true });
  }
}
