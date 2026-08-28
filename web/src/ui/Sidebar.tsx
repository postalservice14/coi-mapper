import { useMemo, useState } from 'react';
import type { Entity } from '../coimap/schema.gen';
import type { LayerName, WorkerDoc } from '../coimap/types';

interface Props {
  doc: WorkerDoc;
  visibility: Record<LayerName, boolean>;
  onToggle: (layer: LayerName) => void;
  onPick: (entityIndex: number) => void;
}

interface LayerRow {
  name: LayerName;
  label: string;
  hint: string;
  /** Absent means always available; otherwise, whether this export contains the layer. */
  needs?: (doc: WorkerDoc) => boolean;
}

const LAYERS: LayerRow[] = [
  { name: 'terrain', label: 'Terrain', hint: 'Natural ground, with hillshading' },
  { name: 'surfaces', label: 'Surfaces', hint: 'Concrete, brick and metal flooring the player has laid', needs: (d) => !!d.layers.surfaces },
  { name: 'deposits', label: 'Deposits', hint: 'Ore and mineral bodies', needs: (d) => !!d.layers.deposits },
  { name: 'designations', label: 'Designations', hint: 'Mining, dumping and forestry areas', needs: (d) => !!d.layers.designations },
  { name: 'entities', label: 'Buildings', hint: 'Placed machines and structures' },
  { name: 'transports', label: 'Conveyors & pipes', hint: 'Logistics runs', needs: (d) => d.transports.length > 0 },
  { name: 'power', label: 'Power grid', hint: 'Electricity and shaft connections', needs: (d) => d.edges.length > 0 },
  { name: 'grid', label: 'Grid', hint: 'Tile grid, heavy lines every 16 tiles' },
];

const MAX_RESULTS = 60;

export function Sidebar({ doc, visibility, onToggle, onPick }: Props) {
  const [query, setQuery] = useState('');

  /** Entity counts per prototype, for the summary list. */
  const byProto = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of doc.entities) counts.set(e.proto, (counts.get(e.proto) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [doc]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: { index: number; entity: Entity }[] = [];
    for (let i = 0; i < doc.entities.length && hits.length < MAX_RESULTS; i++) {
      const e = doc.entities[i]!;
      const proto = doc.protos[e.proto];
      const haystack = `${proto?.name ?? e.proto} ${proto?.category ?? ''}`.toLowerCase();
      if (haystack.includes(q)) hits.push({ index: i, entity: e });
    }
    return hits;
  }, [query, doc]);

  return (
    <aside className="sidebar">
      <section>
        <h3>Layers</h3>
        {LAYERS.map((l) => {
          // An overlay the export never wrote cannot be shown; say so rather than offering
          // a toggle that silently does nothing.
          const available = l.needs ? l.needs(doc) : true;
          return (
            <label
              key={l.name}
              className={`toggle${available ? '' : ' unavailable'}`}
              title={available ? l.hint : `${l.hint} — not present in this export`}
            >
              <input
                type="checkbox"
                checked={available && visibility[l.name]}
                disabled={!available}
                onChange={() => onToggle(l.name)}
              />
              <span>{l.label}</span>
              {!available && <span className="muted"> — not exported</span>}
            </label>
          );
        })}
      </section>

      <section>
        <h3>Find a building</h3>
        <input
          className="search"
          type="search"
          placeholder="Furnace, Power, Storage…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <ul className="results">
            {results.length === 0 && <li className="muted">No matches</li>}
            {results.map(({ index, entity }) => (
              <li key={entity.id}>
                <button onClick={() => onPick(index)}>
                  <span className="swatch" style={{ background: doc.protos[entity.proto]?.color ?? '#888' }} />
                  <span className="grow">{doc.protos[entity.proto]?.name ?? entity.proto}</span>
                  <span className="muted">{entity.x},{entity.y}</span>
                </button>
              </li>
            ))}
            {results.length === MAX_RESULTS && <li className="muted">Showing first {MAX_RESULTS}…</li>}
          </ul>
        )}
      </section>

      <section>
        <h3>Legend</h3>
        <div className="legend-group">
          <h4>Ground</h4>
          {doc.manifest.surfaces.map((s) => (
            <div key={s.id} className="legend-row">
              <span className="swatch" style={{ background: s.color }} /> {s.name}
            </div>
          ))}
        </div>
        {doc.manifest.tileSurfaces.length > 0 && (
          <div className="legend-group">
            <h4>Surfaces</h4>
            {doc.manifest.tileSurfaces.map((t) => (
              <div key={t.id} className="legend-row">
                <span className="swatch" style={{ background: t.color }} /> {t.name}
              </div>
            ))}
          </div>
        )}
        {doc.manifest.deposits.length > 0 && (
          <div className="legend-group">
            <h4>Deposits</h4>
            {doc.manifest.deposits.map((d) => (
              <div key={d.id} className="legend-row">
                <span className="swatch" style={{ background: d.color }} /> {d.name}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Buildings by type</h3>
        <ul className="counts">
          {byProto.slice(0, 20).map(([proto, n]) => (
            <li key={proto}>
              <span className="swatch" style={{ background: doc.protos[proto]?.color ?? '#888' }} />
              <span className="grow">{doc.protos[proto]?.name ?? proto}</span>
              <span className="num">{n}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
