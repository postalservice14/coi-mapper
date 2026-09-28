import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoaderRequest, LoaderResponse } from './loader.worker';
import type { ColourBy } from './entityRaster';
import type { LayerChunk, LoadProgress, WorkerDoc } from './types';

interface State {
  doc: WorkerDoc | null;
  error: string | null;
  progress: LoadProgress | null;
  fileName: string | null;
}

const IDLE: State = { doc: null, error: null, progress: null, fileName: null };

type Pending = { resolve: (chunks: LayerChunk[]) => void; reject: (err: Error) => void };

/**
 * Owns the loader worker: `load(file)` to open a map, then `recolour` to re-bake its
 * buildings layer. The worker stays alive after a load for the second, and is replaced
 * only by the next load.
 */
export function useCoiMap() {
  const [state, setState] = useState<State>(IDLE);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const nextIdRef = useRef(1);

  // A terminated worker never answers, so whatever was waiting on it has to be told.
  const abandon = useCallback(() => {
    for (const p of pendingRef.current.values()) p.reject(new Error('The map was closed.'));
    pendingRef.current.clear();
  }, []);

  useEffect(() => () => { workerRef.current?.terminate(); abandon(); }, [abandon]);

  const load = useCallback(async (file: File) => {
    setState({ ...IDLE, fileName: file.name, progress: { stage: 'reading' } });

    // A fresh worker per load: it guarantees no state leaks between maps and lets a
    // slow load be abandoned simply by terminating it.
    workerRef.current?.terminate();
    abandon();
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<LoaderResponse>) => {
      const msg = event.data;
      if ('recoloured' in msg || 'recolourFailed' in msg) {
        const id = 'recoloured' in msg ? msg.recoloured.id : msg.recolourFailed.id;
        const pending = pendingRef.current.get(id);
        pendingRef.current.delete(id);
        if ('recoloured' in msg) pending?.resolve(msg.recoloured.chunks);
        else pending?.reject(new Error(msg.recolourFailed.error));
      } else if ('progress' in msg) {
        setState((s) => ({ ...s, progress: msg.progress }));
      } else if (msg.ok) {
        setState((s) => ({ ...s, doc: msg.doc, progress: null }));
      } else {
        setState((s) => ({ ...s, error: msg.error, progress: null }));
      }
    };
    worker.onerror = (e) => setState((s) => ({ ...s, error: e.message || 'Loader worker crashed.', progress: null }));

    try {
      const archive = await file.arrayBuffer();
      // ?safe=1 forces the most conservative rendering path, for machines where the
      // normal one fails.
      const params = new URLSearchParams(location.search);
      worker.postMessage(
        { kind: 'load', archive, safeMode: params.get('safe') === '1', debug: params.get('debug') === '1' } satisfies LoaderRequest,
        [archive],
      );
    } catch (err) {
      setState((s) => ({ ...s, error: `Could not read ${file.name}: ${(err as Error).message}`, progress: null }));
    }
  }, [abandon]);

  /** Re-bakes the loaded map's buildings layer; resolves with its new chunks. */
  const recolour = useCallback((colourBy: ColourBy): Promise<LayerChunk[]> => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error('No map is loaded.'));
    const id = nextIdRef.current++;
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      worker.postMessage({ kind: 'recolour', id, colourBy } satisfies LoaderRequest);
    });
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    abandon();
    setState(IDLE);
  }, [abandon]);

  return { ...state, load, recolour, reset };
}
