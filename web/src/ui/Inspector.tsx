import { readTile } from '../coimap/tileInfo';
import { hasSparseFootprint } from '../coimap/footprint';
import { formatLevel, levelAt, levelSpan, stackAt } from '../coimap/stack';
import type { WorkerDoc } from '../coimap/types';

type TileAt = { tx: number; ty: number };

interface Props {
  doc: WorkerDoc;
  selected: number;
  /** The tile the selection was clicked on, or null when it came from search. */
  at: TileAt | null;
  onSelect: (entityIndex: number, at: TileAt | null) => void;
  onClose: () => void;
}

/**
 * Where the entity sits vertically: its level at the clicked tile, and the span a ramp
 * covers. Null when the export predates levels, so the row is left out rather than
 * claiming everything is on the ground.
 */
function describeLevel(doc: WorkerDoc, selected: number, at: TileAt | null): string | null {
  const span = levelSpan(doc, selected);
  if (!span) return null;
  const here = at ? levelAt(doc, selected, at.tx, at.ty) : null;
  const range = span.min === span.max ? formatLevel(span.min) : `${formatLevel(span.min)} to ${formatLevel(span.max)}`;
  if (here === null || span.min === span.max) return range;
  return `${formatLevel(here)} here · ramps ${range}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </div>
  );
}

const ROTATION_LABEL = ['0°', '90°', '180°', '270°'];

export function Inspector({ doc, selected, at, onSelect, onClose }: Props) {
  const entity = doc.entities[selected];
  if (!entity) return null;

  const level = describeLevel(doc, selected, at);
  const stack = at ? stackAt(doc, at.ty * doc.manifest.map.width + at.tx) : [];

  const proto = doc.protos[entity.proto];
  // Sample the terrain under the footprint's origin corner.
  const tile = readTile(doc, entity.x, entity.y);

  return (
    <aside className="inspector">
      <header>
        <span className="swatch big" style={{ background: proto?.color ?? '#888' }} />
        <div className="grow">
          <h2>{proto?.name ?? entity.proto}</h2>
          <p className="muted">{proto?.category ?? 'Unknown category'}</p>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close inspector">×</button>
      </header>

      <section>
        <h3>Placement</h3>
        <Row label="Position" value={`${entity.x}, ${entity.y}`} />
        <Row
          label="Footprint"
          value={
            // A conveyor's bounding box says almost nothing about it; report the tiles it
            // really covers and keep the box as secondary context.
            hasSparseFootprint(entity)
              ? `${(entity.tiles!.length / 2).toLocaleString()} tiles in ${entity.w} × ${entity.h}`
              : `${entity.w} × ${entity.h} tiles`
          }
        />
        {level !== null && <Row label="Level" value={level} />}
        <Row label="Rotation" value={ROTATION_LABEL[entity.rot] ?? `${entity.rot}`} />
        <Row label="State" value={<span className={`state state-${entity.state.toLowerCase()}`}>{entity.state}</span>} />
      </section>

      {at && stack.length > 1 && (
        <section className="stack">
          <h3>Stacked at {at.tx}, {at.ty}</h3>
          <p className="muted">Click the tile again to step down.</p>
          <ul className="results">
            {stack.map((index) => {
              const e = doc.entities[index]!;
              const lvl = levelAt(doc, index, at.tx, at.ty);
              return (
                <li key={e.id}>
                  <button className={index === selected ? 'active' : undefined} onClick={() => onSelect(index, at)}>
                    <span className="swatch" style={{ background: doc.protos[e.proto]?.color ?? '#888' }} />
                    <span className="grow">{doc.protos[e.proto]?.name ?? e.proto}</span>
                    {lvl !== null && <span className="muted">{formatLevel(lvl)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h3>Terrain beneath</h3>
        <Row label="Ground" value={tile.surface?.name ?? '—'} />
        <Row label="Surface" value={tile.tileSurface?.name ?? 'None'} />
        <Row label="Height" value={tile.height === null ? '—' : `${tile.height.toFixed(1)} m`} />
        <Row
          label="Deposit"
          value={
            tile.deposit
              ? `${tile.deposit.name}${tile.depositRichness !== null ? ` (${Math.round(tile.depositRichness * 100)}%)` : ''}`
              : 'None'
          }
        />
        <Row label="Designations" value={tile.designations.join(', ') || 'None'} />
      </section>

      <section>
        <h3>Identity</h3>
        <Row label="Entity id" value={<code>{entity.id}</code>} />
        <Row label="Prototype" value={<code>{entity.proto}</code>} />
      </section>
    </aside>
  );
}
