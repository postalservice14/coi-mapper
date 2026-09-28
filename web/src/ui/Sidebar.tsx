import { useMemo, useState } from 'react';
import type { Entity } from '../coimap/schema.gen';
import type { LayerName, WorkerDoc } from '../coimap/types';
import type { ColourBy } from '../coimap/entityRaster';
import type { BuildingsLook } from '../coimap/loader.worker';
import { BELOW_GROUND, LEVEL_LEGEND, TOP_LEVEL, levelLabel } from '../coimap/levelPalette';
import { FULL_RANGE, isFullRange } from '../coimap/stack';
import type { LevelRange } from '../coimap/stack';

interface Props {
  doc: WorkerDoc;
  visibility: Record<LayerName, boolean>;
  onToggle: (layer: LayerName) => void;
  onPick: (entityIndex: number) => void;
  look: BuildingsLook;
  onLook: (next: Partial<BuildingsLook>) => void;
  /** True while the worker re-bakes the buildings layer for a new look. */
  rebaking: boolean;
  rebakeError: string | null;
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
  // A zone the player never drew an area for has nothing to draw, so availability turns on
  // the polygons rather than on the table: a table of arealess zones is not a layer.
  { name: 'zones', label: 'Logistics zones', hint: 'Areas the player drew to partition the vehicle fleet', needs: (d) => d.manifest.zones.some((z) => z.area.length > 0) },
  { name: 'grid', label: 'Grid', hint: 'Tile grid, heavy lines every 16 tiles' },
];

const MAX_RESULTS = 60;

type LookProps = Pick<Props, 'doc' | 'look' | 'onLook' | 'rebaking'>;

/**
 * The buildings layer's colouring, under its toggle. Height is offered only when the
 * export carries levels — an older one would colour everything "ground", which is wrong
 * rather than merely unhelpful.
 */
function ColourByControl({ doc, look, onLook, rebaking }: LookProps) {
  const option = (mode: ColourBy, label: string, enabled: boolean, title: string) => (
    <button
      className={look.colourBy === mode ? 'on' : undefined}
      aria-pressed={look.colourBy === mode}
      disabled={!enabled || rebaking}
      title={title}
      onClick={() => look.colourBy !== mode && onLook({ colourBy: mode })}
    >
      {label}
    </button>
  );
  return (
    <div className="groupby colour-by" role="group" aria-label="Colour buildings by">
      <span className="muted">Colour by</span>
      {option('category', 'Category', true, 'What each building does')}
      {option('height', 'Height', doc.hasLevels,
        doc.hasLevels ? 'Level above the terrain: what is lifted over what' : 'This export carries no heights — re-export with the current mod')}
      {rebaking && <span className="muted">…</span>}
    </div>
  );
}

/**
 * The band of levels drawn at full strength; the rest fade. Two sliders over the legend's
 * own stops, from "below ground" to "+6 and up", committed when let go rather than on
 * every step of a drag — each commit is a re-bake of the whole layer. Setting both ends
 * to one level is the single-level slice.
 */
function LevelFilter({ doc, look, onLook, rebaking }: LookProps) {
  const [draft, setDraft] = useState<LevelRange | null>(null);
  const shown = draft ?? look.range;
  if (!doc.hasLevels) return null;

  // Each handle pushes the other along rather than crossing it.
  const move = (end: 'min' | 'max', value: number) =>
    setDraft(end === 'min'
      ? { min: value, max: Math.max(value, shown.max) }
      : { min: Math.min(value, shown.min), max: value });
  const commit = () => {
    if (draft && (draft.min !== look.range.min || draft.max !== look.range.max)) onLook({ range: draft });
    setDraft(null);
  };
  const slider = (end: 'min' | 'max', label: string) => (
    <label className="level-slider">
      <span className="muted">{label}</span>
      <input
        type="range"
        min={BELOW_GROUND}
        max={TOP_LEVEL}
        step={1}
        value={shown[end]}
        disabled={rebaking}
        aria-valuetext={levelLabel(shown[end])}
        onChange={(e) => move(end, Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="level-value">{levelLabel(shown[end])}</span>
    </label>
  );

  const filtering = !isFullRange(shown);
  return (
    <div className="level-filter" role="group" aria-label="Levels shown">
      {slider('min', 'Lowest')}
      {slider('max', 'Highest')}
      <p className="muted level-note">
        {filtering
          ? <>{shown.min === shown.max ? `Only ${levelLabel(shown.min)}` : `${levelLabel(shown.min)} to ${levelLabel(shown.max)}`} at full strength; the rest faded. </>
          : <>All levels. </>}
        <kbd>,</kbd> <kbd>.</kbd> step one level{filtering && <>, <kbd>/</kbd> shows all</>}.
        {filtering && (
          <button className="link" disabled={rebaking} onClick={() => onLook({ range: FULL_RANGE })}>Show all</button>
        )}
      </p>
    </div>
  );
}

export function Sidebar({ doc, visibility, onToggle, onPick, look, onLook, rebaking, rebakeError }: Props) {
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
          const row = (
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
          if (l.name !== 'entities') return row;
          return (
            <div key={l.name}>
              {row}
              <ColourByControl doc={doc} look={look} onLook={onLook} rebaking={rebaking} />
              <LevelFilter doc={doc} look={look} onLook={onLook} rebaking={rebaking} />
              {rebakeError && <p className="error-note">{rebakeError}</p>}
            </div>
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
        {look.colourBy === 'height' && (
          <div className="legend-group levels">
            <h4>Height above terrain</h4>
            {LEVEL_LEGEND.map((row) => (
              <div key={row.label} className="legend-row">
                <span className="swatch" style={{ background: row.color }} /> {row.label}
              </div>
            ))}
          </div>
        )}
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
        {/* This is what names the zones: the map draws their colours but no text, so the
            legend is the only place a colour becomes a zone. Arealess zones are listed
            too — they are real zones, just not drawn ones. */}
        {doc.manifest.zones.length > 0 && (
          <div className="legend-group">
            <h4>Logistics zones</h4>
            {doc.manifest.zones.map((z) => (
              <div key={z.id} className="legend-row">
                <span className="swatch" style={{ background: z.color }} /> {z.name}
                {z.area.length === 0 && <span className="muted"> — no area</span>}
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
