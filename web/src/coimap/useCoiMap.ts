import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoaderRequest, LoaderResponse } from './loader.worker';
import type { LoadProgress, WorkerDoc } from './types';

interface State {
  doc: WorkerDoc | null;
  error: string | null;
  progress: LoadProgress | null;
  fileName: string | null;
}

const IDLE: State = { doc: null, error: null, progress: null, fileName: null };

/** Owns the loader worker and exposes a single `load(file)` entry point. */
export function useCoiMap() {
  const [state, setState] = useState<State>(IDLE);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const load = useCallback(async (file: File) => {
    setState({ ...IDLE, fileName: file.name, progress: { stage: 'reading' } });

    // A fresh worker per load: it guarantees no state leaks between maps and lets a
    // slow load be abandoned simply by terminating it.
    workerRef.current?.terminate();
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<LoaderResponse>) => {
      const msg = event.data;
      if ('progress' in msg) {
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
      worker.postMessage({ archive } satisfies LoaderRequest, [archive]);
    } catch (err) {
      setState((s) => ({ ...s, error: `Could not read ${file.name}: ${(err as Error).message}`, progress: null }));
    }
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setState(IDLE);
  }, []);

  return { ...state, load, reset };
}
