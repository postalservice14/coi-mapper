import { readTile } from '../coimap/tileInfo';
import type { TileHit } from '../map/scene';
import type { WorkerDoc } from '../coimap/types';

export function StatusBar({ doc, hit }: { doc: WorkerDoc; hit: TileHit | null }) {
  const { width, height } = doc.manifest.map;

  if (!hit) {
    return (
      <footer className="statusbar">
        <span className="muted">Scroll to zoom · drag to pan · click a building · <kbd>F</kbd> to fit · <kbd>[</kbd> <kbd>]</kbd> to rotate</span>
        <span className="grow" />
        {doc.textureScale > 1 && (
          <span className="muted" title="The map is larger than the texture budget, so layers are drawn at reduced resolution.">
            {doc.textureScale}× downsampled
            <span className="sep">·</span>
          </span>
        )}
        <span className="muted">{width} × {height} tiles</span>
      </footer>
    );
  }

  const tile = readTile(doc, hit.tx, hit.ty);
  const entity = hit.entityIndex >= 0 ? doc.entities[hit.entityIndex] : undefined;

  return (
    <footer className="statusbar">
      <span className="mono">{hit.tx}, {hit.ty}</span>
      <span className="sep">·</span>
      <span>{tile.surface?.name ?? 'Unknown'}</span>
      {tile.height !== null && <><span className="sep">·</span><span>{tile.height.toFixed(1)} m</span></>}
      {tile.deposit && <><span className="sep">·</span><span style={{ color: tile.deposit.color }}>{tile.deposit.name}</span></>}
      {tile.designations.length > 0 && <><span className="sep">·</span><span className="muted">{tile.designations.join('+')}</span></>}
      {entity && (
        <>
          <span className="sep">·</span>
          <strong>{doc.protos[entity.proto]?.name ?? entity.proto}</strong>
        </>
      )}
      <span className="grow" />
      {doc.textureScale > 1 && (
        <span className="muted" title="The map is larger than the texture budget, so layers are drawn at reduced resolution.">
          {doc.textureScale}× downsampled
          <span className="sep">·</span>
        </span>
      )}
      <span className="muted">{width} × {height} tiles</span>
    </footer>
  );
}
