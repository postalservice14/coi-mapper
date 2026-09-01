import { useEffect, useMemo, useRef } from 'react';
import type { VehicleCensus, VehicleCount, VehicleKind } from '../coimap/schema.gen';

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

interface Group {
  kind: VehicleKind;
  rows: VehicleCount[];
  subtotal: number;
}

/**
 * Splits the census into runs of one kind.
 *
 * The exporter emits rows already grouped by kind and sorted by count, so walking them in
 * order and breaking on a change of kind keeps the file's order and the screen's order the
 * same thing — no re-sorting here to drift out of step with the writer.
 */
function groupByKind(types: VehicleCount[]): Group[] {
  const groups: Group[] = [];
  for (const row of types) {
    const last = groups[groups.length - 1];
    if (last && last.kind === row.kind) {
      last.rows.push(row);
      last.subtotal += row.count;
    } else {
      groups.push({ kind: row.kind, rows: [row], subtotal: row.count });
    }
  }
  return groups;
}

/**
 * Totals are recomputed from the rows on screen rather than read off the census, so that
 * hiding a kind cannot leave a header that disagrees with the list under it. The census's
 * own `vehicles` and `trainCars` still count everything, including what is hidden.
 */
function Summary({ census, groups }: { census: VehicleCensus; groups: Group[] }) {
  const shown = (rail: boolean) =>
    groups.filter((g) => RAIL_KINDS.has(g.kind) === rail).reduce((n, g) => n + g.subtotal, 0);
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
  const groups = useMemo(
    () => groupByKind(census.types.filter((row) => !HIDDEN_KINDS.has(row.kind))),
    [census],
  );

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
          <div key={group.kind} className="legend-group">
            <h4>
              {KIND_LABEL[group.kind]} <span className="muted">{group.subtotal.toLocaleString()}</span>
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
