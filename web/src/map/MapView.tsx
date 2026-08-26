import { useEffect, useRef, useState } from 'react';
import { MapScene } from './scene';
import type { TileHit } from './scene';
import type { LayerName, WorkerDoc } from '../coimap/types';

interface Props {
  doc: WorkerDoc;
  /** Which layers are switched on, keyed by layer name. */
  visibility: Record<LayerName, boolean>;
  selected: number;
  onSelect: (entityIndex: number) => void;
  onHover: (hit: TileHit | null) => void;
  /** Set to a tile to recentre the camera there; used by search results. */
  focus: { tx: number; ty: number } | null;
}

/**
 * Collects what actually matters when the renderer fails: the real texture footprint
 * (not the map's nominal size), the canvas backing store, and the driver's own limits.
 * A context that is already lost refuses most queries, so every read is defensive.
 */
function readDiagnostics(canvas: HTMLCanvasElement, doc: WorkerDoc): string[] {
  const { width, height } = doc.manifest.map;
  const scale = doc.textureScale || 1;
  const layerNames = Object.keys(doc.layers);
  const chunks = Object.values(doc.layers).reduce((n, c) => n + (c?.length ?? 0), 0);
  const textureBytes = layerNames.length * Math.ceil(width / scale) * Math.ceil(height / scale) * 4;
  const backing = canvas.width * canvas.height * 4;

  const out = [
    `map	${width.toLocaleString()} × ${height.toLocaleString()} tiles`,
    `layers	${layerNames.join(', ') || 'none'}`,
    `texture	${(textureBytes / 1e6).toFixed(1)} MB in ${chunks} chunks, ${scale}× downsampled`,
    `canvas	${canvas.width} × ${canvas.height} backing (${(backing / 1e6).toFixed(1)} MB), DPR ${window.devicePixelRatio}`,
  ];

  try {
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      out.push(`renderer	${info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable'}`);
      out.push(
        `limits	max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}, ` +
          `max renderbuffer ${gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)}`,
      );
      out.push(`context	${gl.isContextLost() ? 'lost' : 'alive'}`);
    } else {
      out.push('renderer	no WebGL context could be obtained');
    }
  } catch (err) {
    out.push(`renderer	query failed: ${(err as Error)?.message ?? String(err)}`);
  }
  return out;
}

/** Pointer travel, in pixels, above which a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export function MapView({ doc, visibility, selected, onSelect, onHover, focus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const hoveredRef = useRef(-1);

  // Build the scene once per document.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let scene: MapScene | null = null;
    setFailure(null);

    // Losing the WebGL context is the usual way a very large map fails: the driver drops
    // it rather than reporting an allocation failure, and the canvas simply goes black.
    let onContextLost: ((e: Event) => void) | null = null;

    MapScene.create(host, doc)
      .then((s) => {
        // The effect may have been torn down while Pixi was initialising.
        if (disposed) { s.destroy(); return; }
        scene = s;
        sceneRef.current = s;

        onContextLost = (e: Event) => {
          e.preventDefault();
          setFailure('The graphics context was lost.');
          setDiagnostics(readDiagnostics(s.canvas, doc));
        };
        s.canvas.addEventListener('webglcontextlost', onContextLost);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        // Without this the promise rejects unhandled and the canvas stays black with no
        // indication of why.
        setFailure(`Could not start the map renderer: ${(err as Error)?.message ?? String(err)}`);
        const canvas = host.querySelector('canvas');
        if (canvas) setDiagnostics(readDiagnostics(canvas, doc));
      });

    return () => {
      disposed = true;
      setReady(false);
      if (scene && onContextLost) scene.canvas.removeEventListener('webglcontextlost', onContextLost);
      sceneRef.current = null;
      scene?.destroy();
    };
  }, [doc]);

  // Input: wheel to zoom, drag to pan, click to select.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !ready) return;
    const canvas = scene.canvas;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      // Wheel deltas arrive in lines or pages depending on the device; normalise to pixels.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
      scene.zoomAt(x, y, e.deltaY * scale);
      scene.setHighlight(hoveredRef.current, selected);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      dragging = true;
      moved = 0;
      last = local(e);
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = local(e);
      if (dragging) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        scene.panBy(dx, dy);
        last = p;
      }

      const hit = scene.hitTest(p.x, p.y);
      const index = hit?.entityIndex ?? -1;
      if (index !== hoveredRef.current) {
        hoveredRef.current = index;
        scene.setHighlight(index, selected);
      }
      onHover(hit);
      canvas.style.cursor = dragging ? 'grabbing' : index >= 0 ? 'pointer' : 'grab';
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      // A press that barely moved is a click, not the end of a pan.
      if (moved <= DRAG_THRESHOLD) {
        const { x, y } = local(e);
        onSelect(scene.hitTest(x, y)?.entityIndex ?? -1);
      }
    };

    const onLeave = () => {
      hoveredRef.current = -1;
      scene.setHighlight(-1, selected);
      onHover(null);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [ready, selected, onSelect, onHover]);

  // Keyboard shortcuts: F fits the map, Escape clears the selection.
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'f' || e.key === 'F') sceneRef.current?.fitToMap();
      if (e.key === 'Escape') onSelect(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, onSelect]);

  useEffect(() => {
    if (ready) sceneRef.current?.setHighlight(hoveredRef.current, selected);
  }, [ready, selected]);

  useEffect(() => {
    for (const [name, visible] of Object.entries(visibility)) {
      sceneRef.current?.setLayerVisible(name as LayerName, visible);
    }
  }, [ready, visibility]);

  useEffect(() => {
    if (ready && focus) sceneRef.current?.centerOn(focus.tx, focus.ty);
  }, [ready, focus]);

  return (
    <>
      <div ref={hostRef} className="map-host" />
      {failure && (
        <div className="map-failure" role="alert">
          <h2>The map could not be drawn</h2>
          <p>{failure}</p>
          <table className="diagnostics">
            <tbody>
              {diagnostics.map((line) => {
                const [label, ...rest] = line.split('\t');
                return (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>{rest.join(' ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">Please include these figures when reporting the problem.</p>
        </div>
      )}
    </>
  );
}
