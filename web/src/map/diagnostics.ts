/**
 * Renderer diagnostics for the map scene: the URL switches that change or report on the
 * rendering path, and the logging behind `?debug=1`.
 *
 * All of it exists for the case where the map comes up blank. That has several causes
 * that look identical on screen — a lost context, textures that never uploaded, a camera
 * pointed off the map, a canvas covered by something else — and the logs here tell them
 * apart. Keep the default console quiet: everything below is silent without `?debug=1`.
 */
import { Container, Graphics } from 'pixi.js';
import type { Application, Sprite } from 'pixi.js';
import type { LayerName } from '../coimap/types';

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
export const isDebug = () => new URLSearchParams(location.search).get('debug') === '1';

/** Diagnostic logging, silent unless ?debug=1. */
export const debugLog = (...args: unknown[]) => {
  if (isDebug()) console.info('[coi-mapper]', ...args);
};

/** Device pixel ratio that keeps the backing store inside {@link MAX_BACKING_EDGE}. */
export function safeResolution(width: number, height: number): number {
  if (isSafeMode()) return 1;
  const wanted = Math.min(window.devicePixelRatio || 1, 2);
  const longest = Math.max(width, height, 1);
  return Math.min(wanted, MAX_BACKING_EDGE / longest);
}

/**
 * Logs renderer capabilities as soon as the context exists.
 *
 * This runs before anything that could hang or lose the context, so the numbers are in the
 * console either way — which the failure banner cannot promise, since a blocked main thread
 * never paints it.
 */
export function logCapabilities(app: Application, canvas: HTMLCanvasElement, host: HTMLElement) {
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

/**
 * Under `?debug=1`, puts a texture-free shape over the map bounds at the bottom of the
 * world. If this is visible but the layers are not, the camera is fine and the problem is
 * in the textures.
 */
export function addDebugProbe(world: Container, width: number, height: number) {
  if (!isDebug()) return;
  const probe = new Graphics()
    .rect(0, 0, width, height)
    .fill({ color: 0xff00ff, alpha: 0.35 })
    .stroke({ width: Math.max(2, width / 200), color: 0x00ffff });
  world.addChildAt(probe, 0);
  console.info('[coi-mapper] debug: vector probe added over the map bounds');
}

/**
 * Reports what the renderer actually produced.
 *
 * "Nothing visible" has several very different causes — textures that never uploaded,
 * sprites sized or positioned outside the view, or a draw that happened but produced the
 * clear colour. This distinguishes them by reading pixels back straight after a render,
 * before the drawing buffer is swapped.
 */
export function logRenderState(app: Application, world: Container, sprites: ReadonlyMap<LayerName, Container>) {
  if (!isDebug()) return;
  try {
    const layers: Record<string, unknown> = {};
    for (const [name, container] of sprites) {
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

    app.render();

    // Sample the middle of the canvas immediately after rendering: the drawing buffer is
    // still intact within this task, so a uniform result means nothing was drawn there.
    let sample = 'unavailable';
    const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (gl) {
      const size = 32;
      const px = new Uint8Array(size * size * 4);
      const cx = Math.max(0, Math.floor((app.renderer.width - size) / 2));
      const cy = Math.max(0, Math.floor((app.renderer.height - size) / 2));
      gl.readPixels(cx, cy, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const seen = new Set<number>();
      for (let i = 0; i < px.length; i += 4) seen.add((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
      const first = [...seen].slice(0, 3).map((c) => `#${c.toString(16).padStart(6, '0')}`);
      sample = `${seen.size} distinct colours ${first.join(' ')}`;
    }

    // Flattened to plain lines: nested objects are collapsed by most console capture,
    // and a flat log is easier to copy out of DevTools when reporting a problem.
    const lines = [
      `renderer type ${app.renderer.type}, canvas ${app.renderer.width}x${app.renderer.height}`,
      `world scale ${world.scale.x.toFixed(4)} at ${Math.round(world.x)},${Math.round(world.y)}, ` +
        `${app.stage.children.length} stage children`,
      `centre sample: ${sample}`,
    ];
    for (const [name, info] of Object.entries(layers)) {
      lines.push(`layer ${name}: ${JSON.stringify(info)}`);
    }
    for (const line of lines) debugLog(`draw: ${line}`);
    logPresentation(app);
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
function logPresentation(app: Application) {
  if (!isDebug()) return;
  try {
    const canvas = app.canvas as HTMLCanvasElement;
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
    app.ticker.add(count);
    setTimeout(() => {
      // The scene may already have been destroyed — StrictMode tears one down within
      // milliseconds — in which case the ticker is gone and there is nothing to report.
      const ticker = app?.ticker;
      if (!ticker) return;
      ticker.remove(count);
      debugLog(`present: ticker started=${ticker.started}, ${frames} frames in 1s`);
    }, 1000);
  } catch (err) {
    console.warn('[coi-mapper] present: query failed', err);
  }
}
