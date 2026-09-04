import { useEffect, useMemo, useRef, useState } from 'react';
import type { VehicleCensus, VehicleCount, VehicleKind, VehicleZone } from '../coimap/schema.gen';

interface Props {
  census: VehicleCensus;
  open: boolean;
  onClose: () => void;
}

/** Plural headings, in the order the exporter already sorted the rows into. */
const KIND_LABEL: Record<VehicleKind, string> = {
  Truck: 'Trucks',
  Excavator: 'Excavators',
  TreeHarvester: 'Tree harvesters',
  TreePlanter: 'Tree planters',
  Locomotive: 'Locomotives',
  CargoWagon: 'Cargo wagons',
  RocketTransporter: 'Rocket transporters',
  Unknown: 'Other',
};

/**
 * Counted and exported, but not shown here.
 *
 * The rocket transporter is campaign equipment rather than part of the working fleet, and
 * it consumes no vehicle quota — so listing it among the trucks both clutters the panel and
 * makes the total disagree with the game's own vehicle count. It stays in the file for
 * anything that later wants it.
 *
 * Note this is a set of *kinds*, never of Unknown: a machine the exporter did not recognise
 * must always be visible, since that is the only signal that something new exists.
 */
const HIDDEN_KINDS: ReadonlySet<VehicleKind> = new Set<VehicleKind>(['RocketTransporter']);

const RAIL_KINDS: ReadonlySet<VehicleKind> = new Set<VehicleKind>(['Locomotive', 'CargoWagon']);

/** Which way the list is cut. Both read the same rows; only the grouping differs. */
type GroupBy = 'kind' | 'zone';

interface Group {
  /** React key, and nothing else — group identity differs between the two pivots. */
  key: string;
  label: string;
  /** The zone's own colour, for the swatch. Absent when grouping by kind. */
  color?: string;
  rows: VehicleCount[];
  subtotal: number;
  /** Rolling stock, which the summary counts separately from road vehicles. */
  rail: boolean;
}

/** Most numerous first, then by name so equal counts still have one stable order. */
const byCountThenName = (a: VehicleCount, b: VehicleCount) =>
  b.count - a.count || a.name.localeCompare(b.name);

/**
 * Sums rows that describe the same prototype.
 *
 * The file stores one row per prototype *per zone* — the finest grain, so either pivot can
 * be totalled from it. Whenever a group spans more than one zone that grain has to be added
 * back up, or the kind view would show "Haul truck (dump)" three times with a third of the
 * fleet against each.
 *
 * Returns fresh rows: the census belongs to the parsed document, and a panel that summed
 * counts in place would corrupt it the second time it rendered.
 */
function mergeByProto(rows: VehicleCount[]): VehicleCount[] {
  const merged = new Map<string, VehicleCount>();
  for (const row of rows) {
    const seen = merged.get(row.proto);
    if (seen) seen.count += row.count;
    else merged.set(row.proto, { ...row });
  }
  return [...merged.values()].sort(byCountThenName);
}

/**
 * Splits the census into one group per kind, in the order the exporter emitted them.
 *
 * The exporter sorts rows by kind first, so first-seen order here is the file's order — no
 * re-sorting to drift out of step with the writer.
 */
function groupByKind(types: VehicleCount[]): Group[] {
  const groups = new Map<VehicleKind, VehicleCount[]>();
  for (const row of types) {
    const rows = groups.get(row.kind);
    if (rows) rows.push(row);
    else groups.set(row.kind, [row]);
  }

  return [...groups].map(([kind, rows]) => ({
    key: kind,
    label: KIND_LABEL[kind],
    rows: mergeByProto(rows),
    subtotal: rows.reduce((n, row) => n + row.count, 0),
    rail: RAIL_KINDS.has(kind),
  }));
}

/**
 * Splits the census into one group per zone, in the zone table's order.
 *
 * The order comes from the file rather than from a sort here, for the same reason the kind
 * view walks the file's order: the exporter is the one place that decides it.
 *
 * Rolling stock has no zone in the game, so it collects into a single trailing section
 * instead of being forced into one. Empty zones are dropped — a heading with nothing under
 * it reads as a bug rather than as an empty zone.
 */
function groupByZone(types: VehicleCount[], zones: VehicleZone[]): Group[] {
  const byId = new Map<number, VehicleCount[]>(zones.map((zone) => [zone.id, []]));
  const rail: VehicleCount[] = [];
  const stray: VehicleCount[] = [];

  for (const row of types) {
    if (RAIL_KINDS.has(row.kind)) rail.push(row);
    else (byId.get(row.zone) ?? stray).push(row);
  }

  const group = (key: string, label: string, rows: VehicleCount[], rail_: boolean, color?: string): Group => ({
    key,
    label,
    color,
    rows: mergeByProto(rows),
    subtotal: rows.reduce((n, row) => n + row.count, 0),
    rail: rail_,
  });

  const groups = zones.map((zone) =>
    group(`zone-${zone.id}`, zone.name, byId.get(zone.id) ?? [], false, zone.color));

  // A road vehicle pointing at a zone the table does not hold should be impossible: the
  // exporter writes the table and the ids together, and refuses to write one without the
  // other. Show it rather than drop it, on the same reasoning as the Unknown kind — a
  // machine that has gone missing from the totals is the one thing worse than an odd row.
  if (stray.length > 0) groups.push(group('zone-unknown', 'Unknown zone', stray, false));
  if (rail.length > 0) groups.push(group('rail', 'Trains', rail, true));

  return groups.filter((g) => g.rows.length > 0);
}

/**
 * Totals are recomputed from the rows on screen rather than read off the census, so that
 * hiding a kind cannot leave a header that disagrees with the list under it. The census's
 * own `vehicles` and `trainCars` still count everything, including what is hidden.
 */
function Summary({ census, groups }: { census: VehicleCensus; groups: Group[] }) {
  const shown = (rail: boolean) =>
    groups.filter((g) => g.rail === rail).reduce((n, g) => n + g.subtotal, 0);
  const vehicles = shown(false);
  const cars = shown(true);

  return (
    <p className="muted">
      {vehicles.toLocaleString()} vehicles
      {census.trains > 0 && (
        <>
          <span className="sep">·</span>
          {cars.toLocaleString()} cars in {census.trains.toLocaleString()} trains
        </>
      )}
      {/* The quota is the one figure that can be compared against the game's own screen. */}
      {census.limit > 0 && (
        <>
          <span className="sep">·</span>
          limit {census.limit.toLocaleString()}, {census.limitLeft.toLocaleString()} free
        </>
      )}
    </p>
  );
}

export function VehiclesDialog({ census, open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('kind');

  // One zone is every save that never used them, and grouping by it would just retitle the
  // whole list — so the toggle appears only where it has something to separate.
  const canGroupByZone = census.zones.length > 1;
  // Derived rather than reset in an effect: loading a save with no zones while the zone
  // view is showing must fall back to kind, and doing that here means there is no render
  // in between where the mode and the toggle disagree.
  const mode: GroupBy = canGroupByZone ? groupBy : 'kind';

  const groups = useMemo(() => {
    const rows = census.types.filter((row) => !HIDDEN_KINDS.has(row.kind));
    return mode === 'zone' ? groupByZone(rows, census.zones) : groupByKind(rows);
  }, [census, mode]);

  // showModal() and close() are imperative, so drive them from the prop. Guarding on the
  // element's own state is what makes this safe under StrictMode's double-invoked effects:
  // showModal() on an already-open dialog throws.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="fleet"
      // Escape closes the dialog natively; this syncs that back into React's state.
      onClose={onClose}
      // A click landing on the dialog element itself, rather than on its content, is a
      // click on the backdrop.
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <header>
        <div className="grow">
          <h2>Vehicles &amp; trains</h2>
          {census.exported
            ? <Summary census={census} groups={groups} />
            : <p className="muted">Fleet not counted</p>}
          {census.exported && canGroupByZone && (
            <div className="groupby" role="group" aria-label="Group vehicles by">
              <span className="muted">Group by</span>
              <button
                className={mode === 'kind' ? 'on' : undefined}
                aria-pressed={mode === 'kind'}
                onClick={() => setGroupBy('kind')}
              >
                Kind
              </button>
              <button
                className={mode === 'zone' ? 'on' : undefined}
                aria-pressed={mode === 'zone'}
                onClick={() => setGroupBy('zone')}
              >
                Zone
              </button>
            </div>
          )}
        </div>
        <button className="icon" onClick={onClose} aria-label="Close vehicle list">×</button>
      </header>

      <section>
        {!census.exported && (
          <p className="muted">
            This export does not include the fleet. Re-export the save with a newer CoiMapper
            mod to count vehicles and trains.
          </p>
        )}
        {census.exported && groups.length === 0 && (
          <p className="muted">This save has no vehicles or trains.</p>
        )}
        {groups.map((group) => (
          <div key={group.key} className="legend-group">
            <h4>
              {group.color && <span className="swatch" style={{ background: group.color }} />}
              {group.label} <span className="muted">{group.subtotal.toLocaleString()}</span>
            </h4>
            <ul className="counts">
              {group.rows.map((row) => (
                <li key={row.proto}>
                  <span className="grow">{row.name}</span>
                  <span className="num">{row.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </dialog>
  );
}
