import { useCallback, useRef, useState } from 'react';
import type { LoadProgress } from '../coimap/types';

interface Props {
  onFile: (file: File) => void;
  progress: LoadProgress | null;
  error: string | null;
}

const STAGE_LABEL: Record<LoadProgress['stage'], string> = {
  reading: 'Reading file',
  unzipping: 'Opening archive',
  decoding: 'Decoding planes',
  indexing: 'Indexing entities',
  rendering: 'Building map layers',
  done: 'Finishing up',
};

export function DropZone({ onFile, progress, error }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  }, [onFile]);

  if (progress) {
    return (
      <div className="dropzone">
        <div className="panel loading">
          <div className="spinner" />
          <h2>{STAGE_LABEL[progress.stage]}</h2>
          {progress.detail && <p className="muted">{progress.detail}</p>}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
    >
      <div className="panel">
        <h1>Captain of Industry — Interactive Map</h1>
        <p className="lead">Drop a <code>.coimap</code> file here, or</p>
        <button className="primary" onClick={() => inputRef.current?.click()}>Choose a file</button>
        <input
          ref={inputRef}
          type="file"
          accept=".coimap,application/zip"
          hidden
          onChange={(e) => take(e.target.files)}
        />

        {error && <p className="error" role="alert">{error}</p>}

        <details className="help">
          <summary>Where do I get a .coimap file?</summary>
          <p>
            Captain of Industry saves are a serialised C# object graph that only the game's own
            assemblies can read, so this app cannot open a <code>.save</code> directly.
          </p>
          <ol>
            <li>Install the <strong>CoiMapper</strong> exporter mod into <code>%APPDATA%/Captain of Industry/Mods/</code>.</li>
            <li>Launch the game and load your save.</li>
            <li>Trigger <strong>Export map</strong>; the mod writes a <code>.coimap</code> next to your saves.</li>
            <li>Drop that file here.</li>
          </ol>
        </details>
      </div>
    </div>
  );
}
