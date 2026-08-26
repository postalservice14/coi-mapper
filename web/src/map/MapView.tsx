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

/** Pointer travel, in pixels, above which a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export function MapView({ doc, visibility, selected, onSelect, onHover, focus }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const [ready, setReady] = useState(false);
  const hoveredRef = useRef(-1);

  // Build the scene once per document.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let scene: MapScene | null = null;

    MapScene.create(canvas, doc).then((s) => {
      // The effect may have been torn down while Pixi was initialising.
      if (disposed) { s.destroy(); return; }
      scene = s;
      sceneRef.current = s;
      setReady(true);
    });

    return () => {
      disposed = true;
      setReady(false);
      sceneRef.current = null;
      scene?.destroy();
    };
  }, [doc]);

  // Input: wheel to zoom, drag to pan, click to select.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;

    const scene = sceneRef.current!;
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

  return <canvas ref={canvasRef} className="map-canvas" />;
}
