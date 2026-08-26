import { readTile } from '../coimap/tileInfo';
import type { WorkerDoc } from '../coimap/types';

interface Props {
  doc: WorkerDoc;
  selected: number;
  onClose: () => void;
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

export function Inspector({ doc, selected, onClose }: Props) {
  const entity = doc.entities[selected];
  if (!entity) return null;

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
        <Row label="Footprint" value={`${entity.w} × ${entity.h} tiles`} />
        <Row label="Rotation" value={ROTATION_LABEL[entity.rot] ?? `${entity.rot}`} />
        <Row label="State" value={<span className={`state state-${entity.state.toLowerCase()}`}>{entity.state}</span>} />
      </section>

      <section>
        <h3>Terrain beneath</h3>
        <Row label="Surface" value={tile.surface?.name ?? '—'} />
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
