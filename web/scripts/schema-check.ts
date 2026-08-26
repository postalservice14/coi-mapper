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

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} contract checks passed\n`);
process.exit(failed.length ? 1 : 0);
