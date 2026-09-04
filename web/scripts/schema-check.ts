/**
 * Cross-language contract test.
 *
 * Reads an archive produced by the C# exporter's own writer classes (see
 * mod/CoiMapper.SchemaCheck) using the real TypeScript parser, and asserts the values
 * survive intact. This is where a disagreement between the two sides shows up — JSON
 * escaping, enum encoding, plane byte order, or row-major convention.
 */
import { readFileSync } from 'node:fs';
import { parseCoiMap, buildTileIndex } from '../src/coimap/parse.ts';
import { buildTextures } from '../src/coimap/terrain.ts';
import { readTile } from '../src/coimap/tileInfo.ts';

const [input = 'schema-check.coimap'] = process.argv.slice(2);

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  checks.push({ name, ok, detail: String(detail) });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
};

const doc = parseCoiMap(new Uint8Array(readFileSync(input)));
const { width, height } = doc.manifest.map;

check('archive parses', true, `${width}x${height}`);
check('schema version agrees', doc.manifest.schemaVersion === 2, doc.manifest.schemaVersion);
check('game info survives', doc.manifest.game.mapName === 'Schema Check' && doc.manifest.game.saveVersion === 287,
  `${doc.manifest.game.mapName} / save ${doc.manifest.game.saveVersion}`);

// C# floats are written with "R" and invariant culture; a comma-decimal locale would break this.
check('float round-trip', doc.manifest.map.minHeight === -12.5 && doc.manifest.map.maxHeight === 240.25,
  `${doc.manifest.map.minHeight} … ${doc.manifest.map.maxHeight}`);

check('entities decoded', doc.entities.length === 4, doc.entities.length);

// Sparse footprints: the conveyor must cover only its 13 traced tiles, not its 10x8 box.
const belt = doc.entities.find((e) => e.proto === 'ConveyorT2');
check('sparse footprint survives', belt?.tiles?.length === 26, `${(belt?.tiles?.length ?? 0) / 2} tiles`);
const beltIndex = buildTileIndex(doc.entities, width, height);
const beltAt = (x: number, y: number) => beltIndex[y * width + x] === doc.entities.indexOf(belt!);
check(
  'sparse footprint is not rasterised as its box',
  beltAt(30, 20) && beltAt(33, 22) && beltAt(39, 23) && !beltAt(35, 20) && !beltAt(38, 26),
  'traced tiles set, interior of the box left clear',
);

// Enums must arrive as the schema's string names, not integers.
const states = doc.entities.map((e) => e.state).join(',');
check('enums encoded as names', states === 'Operating,Constructing,Broken,Operating', states);

// JSON escaping of quotes, em dash and diacritics.
const unicode = doc.entities[2]?.proto;
check('unicode and quotes escape correctly', unicode === 'Pump "A" — ünïcode', JSON.stringify(unicode));

// ── the vehicle census ───────────────────────────────────────────────────────
// Written through the exporter's real VehicleTally, so these assertions cover the
// aggregation and the sort, not just the serialisation.
const fleet = doc.manifest.vehicles;
check('vehicle census is marked exported', fleet.exported === true, fleet.exported);

// A brand-new enum: the case the "enums encoded as names" check above exists for.
const kinds = fleet.types.map((v) => v.kind).join(',');
check('vehicle kinds encoded as names',
  kinds === 'Unknown,Unknown,Unknown,Truck,Truck,Truck,Excavator,Locomotive,CargoWagon,RocketTransporter',
  kinds);

// Rows must arrive grouped by kind ordinal, then zone, then count descending — the panel
// leans on this order, so a lost sort would show up as a jumbled list.
const order = fleet.types.map((v) => `${v.proto}:${v.count}`).join(' ');
check('census rows keep kind-then-zone-then-count order',
  order === 'DozerA:8 DozerB:5 MysteryCraft:1 TruckSmall:5 TruckLarge:7 TruckLarge:4 ExcavatorT1:1 LocoDiesel:4 WagonCargo:6 RocketTransporterT1:1',
  order);

// ── logistics zones ──────────────────────────────────────────────────────────
// Zones live on the manifest, not on the census: the map layer draws them and the vehicle
// panel groups by them, so neither owns the table.
const zones = doc.manifest.zones;
const zoneOrder = zones.map((z) => `${z.id}:${z.name}`).join(' ');
check('zone table survives in writer order',
  zoneOrder === '1:Default 2:Mining north 3:Smelter "hot" yard — ünïcode', zoneOrder);
check('exactly one zone is marked default',
  zones.filter((z) => z.isDefault).length === 1 && zones[0].isDefault === true,
  zones.filter((z) => z.isDefault).map((z) => z.name).join(','));
check('zone colours survive as #rrggbb',
  zones.every((z) => /^#[0-9a-f]{6}$/.test(z.color)),
  zones.map((z) => z.color).join(' '));

// The polygon. Written as a deliberately non-convex L wound clockwise, so a vertex lost,
// a ring closed early or a winding reversed shows up as a different shape rather than as
// the same rectangle. Flattened x,y pairs, exactly as Transport.points are.
const mining = zones.find((z) => z.id === 2);
check('zone polygon survives vertex for vertex',
  mining?.area.join(',') === '4,4,24,4,24,14,14,14,14,30,4,30', mining?.area.join(',') ?? 'missing');
check('zone polygons are flat x,y pairs',
  zones.every((z) => z.area.length % 2 === 0),
  zones.map((z) => z.area.length).join(' '));

// A zone the player has drawn no area for. It must survive as an empty ring rather than
// as a missing field: the layer draws nothing for it, which is different from not knowing.
const undrawn = zones.find((z) => z.id === 3);
check('a zone with no area keeps an empty ring',
  Array.isArray(undrawn?.area) && undrawn.area.length === 0, JSON.stringify(undrawn?.area));

// Every row either points at a real zone or says it has none. A row pointing at a zone
// that is not in the table would render under a group the panel had to invent.
const zoneIds = new Set(zones.map((z) => z.id));
const dangling = fleet.types.filter((v) => v.zone !== -1 && !zoneIds.has(v.zone));
check('every row resolves to a zone or to none', dangling.length === 0,
  dangling.map((v) => `${v.proto}->${v.zone}`).join(' '));

// Train cars have no zone in the game; road vehicles always have one.
const rail = fleet.types.filter((v) => v.kind === 'Locomotive' || v.kind === 'CargoWagon');
const road = fleet.types.filter((v) => v.kind !== 'Locomotive' && v.kind !== 'CargoWagon');
check('train cars carry no zone', rail.every((v) => v.zone === -1),
  rail.map((v) => `${v.proto}:${v.zone}`).join(' '));
check('road vehicles all carry a zone', road.every((v) => v.zone !== -1),
  road.map((v) => `${v.proto}:${v.zone}`).join(' '));

// One prototype spread across two zones: two rows in the file, one row once the panel
// totals by kind. This is the grain the format is stored at.
const large = fleet.types.filter((v) => v.proto === 'TruckLarge');
check('one prototype splits into a row per zone',
  large.length === 2 && large.map((v) => `${v.zone}:${v.count}`).join(' ') === '2:7 3:4',
  large.map((v) => `${v.zone}:${v.count}`).join(' '));
check('a split prototype keeps one label',
  new Set(large.map((v) => v.name)).size === 1 && large[0].name === 'Haul truck "big" — ünïcode',
  large.map((v) => v.name).join(' / '));

// The panel hides rocket transporters, but the file must still carry them: the point of
// hiding a kind in the UI is that the data stays available to anything that wants it.
const rocket = fleet.types.find((v) => v.kind === 'RocketTransporter');
check('hidden kinds are still exported', rocket?.proto === 'RocketTransporterT1' && rocket.count === 1,
  rocket ? `${rocket.name} x${rocket.count}` : 'missing');

// Two prototypes sharing a name would otherwise render as one label with two counts and
// no way to tell them apart. This is the net under the exporter's fuel-variant naming.
const dozers = fleet.types.filter((v) => v.name.startsWith('Bulldozer')).map((v) => v.name);
check('colliding names fall back to the prototype id',
  dozers.join(' / ') === 'Bulldozer (DozerA) / Bulldozer (DozerB)', dozers.join(' / '));

// Every prototype in the panel must be distinct, however it got that way. Rows are no
// longer unique by name — one prototype has a row per zone — so this asks the question
// that still matters: two different prototypes must never share a label.
const byProto = new Map(fleet.types.map((v) => [v.proto, v.name]));
check('distinct prototypes have distinct labels',
  new Set(byProto.values()).size === byProto.size,
  `${new Set(byProto.values()).size} distinct of ${byProto.size}`);

// TruckSmall was added in two separate batches of 3 and 2, both in the same zone.
const small = fleet.types.find((v) => v.proto === 'TruckSmall');
check('repeated prototypes aggregate into one row', small?.count === 5, small?.count);

const fleetName = fleet.types.find((v) => v.proto === 'TruckLarge')?.name;
check('vehicle names escape correctly', fleetName === 'Haul truck "big" — ünïcode', JSON.stringify(fleetName));

// Totals are accumulated separately from the rows, so they can drift apart.
const sum = (rows: typeof fleet.types) => rows.reduce((n, v) => n + v.count, 0);
check('census totals match the rows they came from',
  fleet.vehicles === sum(road) && fleet.trainCars === sum(rail),
  `${fleet.vehicles} road / ${fleet.trainCars} rail`);
check('train and quota figures survive',
  fleet.trains === 2 && fleet.limit === 40 && fleet.limitLeft === 27,
  `${fleet.trains} trains, limit ${fleet.limit}/${fleet.limitLeft} free`);

// The plane was filled with x*1000 + y, which is asymmetric — a transposed or
// column-major write would fail here rather than looking plausible.
const h = doc.planes.height!;
const probes: [number, number][] = [[0, 0], [1, 0], [0, 1], [63, 47], [17, 33]];
const bad = probes.filter(([x, y]) => h[y * width + x] !== x * 1000 + y);
check('height plane is row-major, little-endian', bad.length === 0,
  bad.length ? `mismatch at ${bad.map(([x, y]) => `(${x},${y})=${h[y * width + x]}`).join(' ')}` : `${probes.length} probes`);

check('surface legend present', doc.manifest.surfaces.length === 4, doc.manifest.surfaces.map((s) => s.name).join(', '));
check('water flag round-trips as boolean',
  doc.manifest.surfaces[0]?.water === true && doc.manifest.surfaces[1]?.water === false,
  `${doc.manifest.surfaces[0]?.water} / ${doc.manifest.surfaces[1]?.water}`);
check('unknown material got a fallback colour',
  /^#[0-9a-f]{6}$/i.test(doc.manifest.surfaces[3]?.color ?? ''), doc.manifest.surfaces[3]?.color);

// The optional overlay planes. Both blobs sit off-centre and off-diagonal, so a
// transposed write shows up as a miss rather than as plausible data.
const dep = doc.planes.deposit!;
const amt = doc.planes.depositAmount!;
check('deposit plane decodes, 0 where there is none',
  dep[2 * width + 3] === 1 && dep[10 * width + 13] === 2 && dep[0] === 0 && dep[47 * width + 63] === 0,
  `(3,2)=${dep[2 * width + 3]} (13,10)=${dep[10 * width + 13]} (0,0)=${dep[0]}`);
check('deposit amount is u16 little-endian',
  amt[2 * width + 3] === 3 * 4096 + 2 && amt[10 * width + 13] === 65535,
  `(3,2)=${amt[2 * width + 3]} expected ${3 * 4096 + 2}`);
check('deposit legend present',
  doc.manifest.deposits.length === 2 && doc.manifest.deposits[0]?.id === 1,
  doc.manifest.deposits.map((d) => `${d.id}:${d.name}`).join(', '));

// Player-placed paving. The slab is wide and short and its ids are nested, so a
// transposed write misses it and an id collapsed to a boolean fails the middle probe.
const paved = doc.planes.tileSurface!;
check('tileSurface plane decodes, 0 where unpaved',
  paved[7 * width + 21] === 1 && paved[7 * width + 24] === 2 && paved[7 * width + 25] === 3
    && paved[0] === 0 && paved[21 * width + 7] === 0,
  `(21,7)=${paved[7 * width + 21]} (24,7)=${paved[7 * width + 24]} (25,7)=${paved[7 * width + 25]} (7,21)=${paved[21 * width + 7]}`);
check('tileSurface legend present and unshifted',
  doc.manifest.tileSurfaces.length === 3 && doc.manifest.tileSurfaces[0]?.id === 1,
  doc.manifest.tileSurfaces.map((t) => `${t.id}:${t.name}`).join(', '));
check('unknown surface got a fallback colour',
  /^#[0-9a-f]{6}$/i.test(doc.manifest.tileSurfaces[2]?.color ?? ''), doc.manifest.tileSurfaces[2]?.color);
check('surface id splits camel case when unlocalised',
  doc.manifest.tileSurfaces[2]?.name === 'Modded Glass Floor', doc.manifest.tileSurfaces[2]?.name);

// A tile can carry several designations at once, so the mask must survive as a mask
// rather than as whichever bit was written last.
const des = doc.planes.designation!;
check('designation bits combine on one tile',
  des[0 * width + 61] === 1 + 2 && des[5 * width + 5] === 8 && des[20 * width + 20] === 0,
  `(61,0)=${des[0 * width + 61]} (5,5)=${des[5 * width + 5]}`);

// The reader the status bar actually uses, not just the raw plane.
const tile = readTile(doc, 3, 2);
check('readTile resolves deposit and designations',
  tile.deposit?.name === 'Crude oil' && tile.designations.includes('Mine'),
  `${tile.deposit?.name} / ${tile.designations.join('+')} / richness ${tile.depositRichness?.toFixed(3)}`);

const pavedTile = readTile(doc, 25, 7);
check('readTile resolves paving separately from ground',
  pavedTile.tileSurface?.name === 'Modded Glass Floor' && pavedTile.surface !== null
    && readTile(doc, 0, 0).tileSurface === null,
  `${pavedTile.surface?.name} + ${pavedTile.tileSurface?.name}`);

check('transport polyline decoded',
  doc.transports.length === 1 && doc.transports[0]!.points.join(',') === '4,7,10,7,10,10',
  doc.transports[0]?.points.join(','));
check('network edge decoded',
  doc.edges.length === 1 && doc.edges[0]!.kind === 'Electricity' && doc.edges[0]!.a === 1, doc.edges[0]?.kind);

// The renderer must accept this document, not just the parser.
const index = buildTileIndex(doc.entities, width, height);
check('tile index built', index[4 * width + 4] === 0 && index[0] === -1, `entity 0 at (4,4)`);

const textures = buildTextures(doc.planes, doc.manifest);
check('textures build from C# output', textures.terrain.length === width * height * 4, `${textures.terrain.length} bytes`);
check('overlay textures build from the new planes',
  textures.deposits !== null && textures.designations !== null && textures.surfaces !== null,
  `deposits ${textures.deposits ? 'built' : 'null'}, designations ${textures.designations ? 'built' : 'null'}, ` +
    `surfaces ${textures.surfaces ? 'built' : 'null'}`);
// Paving is drawn near-opaque and hillshaded; unpaved tiles must stay fully transparent so
// the terrain shows through rather than being covered by a black layer.
check('paving texture is opaque where paved and clear where not',
  textures.surfaces![(7 * width + 25) * 4 + 3] > 200 && textures.surfaces![3] === 0,
  `alpha paved ${textures.surfaces![(7 * width + 25) * 4 + 3]}, unpaved ${textures.surfaces![3]}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} contract checks passed\n`);
process.exit(failed.length ? 1 : 0);
