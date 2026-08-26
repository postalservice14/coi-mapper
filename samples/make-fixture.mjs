#!/usr/bin/env node
/**
 * Generates a synthetic but plausible `.coimap` so the web app can be developed
 * without a Windows machine running Captain of Industry.
 *
 * It writes exactly the same archive the real exporter mod will, so anything built
 * against this fixture works unchanged against a real export.
 *
 *   node samples/make-fixture.mjs [--out samples/fixture.coimap] [--size 512] [--seed 7]
 */
import { writeFileSync } from 'node:fs';
import { createZip } from './zip.mjs';
import { encodeJpeg } from './jpeg.mjs';
import * as S from '../schema/coimap.spec.mjs';

// ── deterministic noise ──────────────────────────────────────────────────────
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Value-noise lattice sampled with smoothstep interpolation. */
function makeNoise(seed, gridSize) {
  const rnd = mulberry32(seed);
  const g = new Float32Array((gridSize + 1) * (gridSize + 1));
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x, y) => {
    const fx = x * gridSize, fy = y * gridSize;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = smoothstep(fx - x0), ty = smoothstep(fy - y0);
    const at = (px, py) => g[Math.min(gridSize, py) * (gridSize + 1) + Math.min(gridSize, px)];
    return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
  };
}

/** Fractal Brownian motion: octaves of value noise at doubling frequency. */
function fbm(seed, octaves = 5) {
  const layers = Array.from({ length: octaves }, (_, i) => makeNoise(seed + i * 977, 4 << i));
  return (x, y) => {
    let sum = 0, amp = 1, norm = 0;
    for (const n of layers) { sum += n(x, y) * amp; norm += amp; amp *= 0.5; }
    return sum / norm;
  };
}

// ── terrain ──────────────────────────────────────────────────────────────────
const SURFACE = { Ocean: 0, Sand: 1, Grass: 2, Rock: 3, Snow: 4 };
const SEA_LEVEL = 0.42;

/** Legend for the surface plane. */
const SURFACES = [
  { id: 0, name: 'Ocean', color: '#1b4a6b', water: true },
  { id: 1, name: 'Sand',  color: '#c9b083', water: false },
  { id: 2, name: 'Grass', color: '#5d7a3a', water: false },
  { id: 3, name: 'Rock',  color: '#7a7469', water: false },
  { id: 4, name: 'Snow',  color: '#dfe4e8', water: false },
];

/** Legend for the deposit plane; id 0 means no deposit. */
const DEPOSITS = [
  { id: 1, name: 'Coal',        color: '#2f2f33' },
  { id: 2, name: 'Iron Ore',    color: '#a3542f' },
  { id: 3, name: 'Copper Ore',  color: '#2f8f77' },
  { id: 4, name: 'Gold Ore',    color: '#d4af37' },
  { id: 5, name: 'Limestone',   color: '#cfc6ae' },
];

function buildTerrain(size, seed) {
  const n = size * size;
  const height = new Uint16Array(n);
  const surface = new Uint8Array(n);
  const material = new Uint8Array(n);
  const deposit = new Uint8Array(n);
  const depositAmount = new Uint16Array(n);

  const land = fbm(seed, 5);
  const ore = fbm(seed + 4242, 3);
  // Raw value noise, not fbm: averaging octaves pulls values toward 0.5, which would
  // bias every deposit toward the middle ore types.
  const oreKind = makeNoise(seed + 8484, 9);
  const elevation = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Radial falloff turns the noise field into an island rather than edge-to-edge land.
      const dx = u - 0.5, dy = v - 0.5;
      const mask = clamp01(1.35 - Math.sqrt(dx * dx + dy * dy) * 2.1);
      const e = clamp01(land(u, v) * 0.75 + 0.35) * mask;
      const i = y * size + x;
      elevation[i] = e;
      height[i] = Math.round(clamp01(e) * 65535);

      surface[i] = e < SEA_LEVEL ? SURFACE.Ocean
        : e < SEA_LEVEL + 0.03 ? SURFACE.Sand
        : e < 0.68 ? SURFACE.Grass
        : e < 0.82 ? SURFACE.Rock
        : SURFACE.Snow;
      material[i] = surface[i];

      // Ore bodies: sparse high-noise blobs, on land only.
      const o = ore(u, v);
      const ORE_THRESHOLD = 0.56;
      if (e >= SEA_LEVEL && o > ORE_THRESHOLD) {
        deposit[i] = 1 + Math.floor(clamp01(oreKind(u, v)) * 4.999);
        depositAmount[i] = Math.round(clamp01((o - ORE_THRESHOLD) / 0.2) * 65535);
      }
    }
  }
  return { height, surface, material, deposit, depositAmount, elevation };
}

// ── prototypes ───────────────────────────────────────────────────────────────
const PROTOS = [
  ['Furnace',          'Smelting',    3, 3], ['ArcFurnace',     'Smelting',    4, 4],
  ['Foundry',          'Smelting',    4, 3], ['Assembler',      'Manufacture', 3, 3],
  ['Workshop',         'Manufacture', 4, 3], ['MachineShop',    'Manufacture', 4, 4],
  ['ChemicalPlant',    'Chemistry',   4, 4], ['Distillery',     'Chemistry',   3, 5],
  ['Electrolyser',     'Chemistry',   3, 3], ['CrusherLarge',   'Mining',      4, 3],
  ['OreSorter',        'Mining',      5, 4], ['MineTower',      'Mining',      3, 3],
  ['DieselGenerator',  'Power',       4, 3], ['SteamTurbine',   'Power',       5, 3],
  ['SolarPanel',       'Power',       3, 3], ['Boiler',         'Power',       3, 4],
  ['Pylon',            'Power',       1, 1], ['StorageUnit',    'Storage',     4, 4],
  ['FluidTank',        'Fluid',       3, 3], ['WaterPump',      'Fluid',       2, 3],
  ['SettlementHouse',  'Settlement',  4, 4], ['Farm',           'Farming',     6, 6],
  ['ForestryTower',    'Farming',     3, 3], ['TruckDepot',     'Transport',   5, 4],
  ['ConveyorBelt',     'Transport',   1, 1], ['Pipe',           'Fluid',       1, 1],
].map(([id, category, w, h]) => ({
  id, category, w, h,
  name: id.replace(/([a-z])([A-Z])/g, '$1 $2'),
  color: S.CATEGORY_COLORS[category] ?? S.CATEGORY_COLORS.Other,
}));

const byId = Object.fromEntries(PROTOS.map((p) => [p.id, p]));
const BUILDABLE = PROTOS.filter((p) => !['ConveyorBelt', 'Pipe', 'Pylon'].includes(p.id));
const STATES = ['Operating', 'Operating', 'Operating', 'Idle', 'Constructing', 'Paused', 'Broken'];

/** Walks a flat [x0,y0,x1,y1,...] polyline into the distinct tiles it passes through. */
function tracePolyline(points) {
  const seen = new Set();
  const tiles = [];
  const add = (x, y) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push([x, y]);
  };

  for (let i = 0; i + 3 < points.length; i += 2) {
    let [x, y] = [points[i], points[i + 1]];
    const [tx, ty] = [points[i + 2], points[i + 3]];
    // Manhattan walk: axis-aligned like real conveyor runs, rather than a diagonal line.
    while (x !== tx) { add(x, y); x += Math.sign(tx - x); }
    while (y !== ty) { add(x, y); y += Math.sign(ty - y); }
    add(x, y);
  }
  return tiles;
}

// ── factory layout ───────────────────────────────────────────────────────────
/**
 * Places clusters of machines on flat-enough land, wires each cluster with a conveyor
 * run, and links every cluster back to a power spine.
 */
function placeEntities(size, terrain, seed) {
  const rnd = mulberry32(seed + 31337);
  const { elevation } = terrain;
  const occupancy = new Uint8Array(size * size);
  const designation = new Uint8Array(size * size);
  const entities = [];
  const transports = [];
  const edges = [];
  let nextId = 1;

  const buildable = (x, y, w, h) => {
    if (x < 1 || y < 1 || x + w >= size - 1 || y + h >= size - 1) return false;
    let min = 1, max = 0;
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const k = j * size + i;
        if (occupancy[k]) return false;
        const e = elevation[k];
        if (e < SEA_LEVEL + 0.02) return false;   // not on water or beach
        if (e < min) min = e;
        if (e > max) max = e;
      }
    }
    return max - min < 0.05;                      // reject steep ground
  };

  const occupy = (x, y, w, h) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) occupancy[j * size + i] = 1;
  };

  const place = (proto, x, y, rot) => {
    const [w, h] = rot % 2 ? [proto.h, proto.w] : [proto.w, proto.h];
    if (!buildable(x, y, w, h)) return null;
    occupy(x, y, w, h);
    const e = { id: nextId++, proto: proto.id, x, y, w, h, rot, state: STATES[Math.floor(rnd() * STATES.length)] };
    entities.push(e);
    return e;
  };

  // Sampling origins uniformly over the map mostly lands in the ocean, so draw them
  // from the set of land tiles instead.
  const landTiles = [];
  for (let i = 0; i < elevation.length; i++) {
    if (elevation[i] >= SEA_LEVEL + 0.03) landTiles.push(i);
  }

  // Clusters of same-category machines, each fed by one conveyor run.
  const CLUSTERS = 420;
  const ATTEMPTS = 40;
  const hubs = [];
  for (let c = 0; c < CLUSTERS; c++) {
    const proto = BUILDABLE[Math.floor(rnd() * BUILDABLE.length)];
    const rot = Math.floor(rnd() * 4);
    const count = 3 + Math.floor(rnd() * 6);
    const [pw, ph] = rot % 2 ? [proto.h, proto.w] : [proto.w, proto.h];
    const horizontal = rnd() < 0.5;

    const placed = [];
    for (let attempt = 0; attempt < ATTEMPTS && placed.length === 0; attempt++) {
      const t = landTiles[Math.floor(rnd() * landTiles.length)];
      const originX = t % size, originY = (t / size) | 0;
      for (let i = 0; i < count; i++) {
        const x = originX + (horizontal ? i * (pw + 2) : 0);
        const y = originY + (horizontal ? 0 : i * (ph + 2));
        const e = place(proto, x, y, rot);
        if (e) placed.push(e);
      }
    }
    if (placed.length < 2) continue;

    // One conveyor polyline threading the cluster.
    const points = [];
    for (const e of placed) points.push(e.x + Math.floor(e.w / 2), e.y + e.h + 1);
    const isPipe = rnd() < 0.25;
    transports.push({
      id: nextId++,
      proto: isPipe ? 'Pipe' : 'ConveyorBelt',
      kind: isPipe ? 'Pipe' : 'Conveyor',
      points,
    });

    // The game exports conveyors and pipes as ordinary entities whose occupied tiles trace
    // the run, so their bounding box is mostly empty. Mirror that here: a fixture that only
    // modelled them as network polylines would never exercise the sparse-footprint path.
    const traced = tracePolyline(points);
    if (traced.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [tx, ty] of traced) {
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
      const tiles = [];
      for (const [tx, ty] of traced) tiles.push(tx - minX, ty - minY);
      entities.push({
        id: nextId++,
        proto: isPipe ? 'Pipe' : 'ConveyorBelt',
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        rot: 0,
        state: 'Operating',
        tiles,
      });
      for (const [tx, ty] of traced) occupancy[ty * size + tx] = 1;
    }

    // Mine towers designate the ore around them.
    if (proto.id === 'MineTower' || proto.id === 'ForestryTower') {
      const bit = proto.id === 'MineTower' ? S.DESIGNATION_BITS.Mine : S.DESIGNATION_BITS.Forestry;
      const head = placed[0], r = 14;
      for (let j = Math.max(0, head.y - r); j < Math.min(size, head.y + r); j++) {
        for (let i = Math.max(0, head.x - r); i < Math.min(size, head.x + r); i++) {
          const dx = i - head.x, dy = j - head.y;
          if (dx * dx + dy * dy < r * r) designation[j * size + i] |= bit;
        }
      }
    }

    hubs.push(placed[0]);
  }

  // Trunk runs between distant clusters. These are what make the sparse-footprint case
  // real: a dog-legged belt across the map has a bounding box of tens of thousands of
  // tiles while covering only a few hundred, exactly like the game's own long conveyors.
  // Sparse enough to stay readable: a handful of long hauls, not one per cluster.
  for (let i = 0; i + 1 < hubs.length; i += 12) {
    const a = hubs[i];
    const b = hubs[i + 1];
    if (!a || !b) continue;

    const ax = a.x + (a.w >> 1);
    const ay = a.y + (a.h >> 1);
    const bx = b.x + (b.w >> 1);
    const by = b.y + (b.h >> 1);
    if (Math.abs(ax - bx) + Math.abs(ay - by) < 60) continue;   // keep trunks long

    // Route via a mid waypoint so the run turns corners instead of running straight.
    const midX = rnd() < 0.5 ? ax : bx;
    const midY = rnd() < 0.5 ? by : ay;
    const traced = tracePolyline([ax, ay, midX, midY, bx, by]);
    if (traced.length === 0) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [tx, ty] of traced) {
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    const tiles = [];
    for (const [tx, ty] of traced) tiles.push(tx - minX, ty - minY);

    const isPipe = rnd() < 0.3;
    entities.push({
      id: nextId++,
      proto: isPipe ? 'Pipe' : 'ConveyorBelt',
      x: minX, y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      rot: 0,
      state: 'Operating',
      tiles,
    });
    transports.push({
      id: nextId++,
      proto: isPipe ? 'Pipe' : 'ConveyorBelt',
      kind: isPipe ? 'Pipe' : 'Conveyor',
      points: [ax, ay, midX, midY, bx, by],
    });
  }

  // Power spine: chain the cluster hubs together, with a pylon at each.
  for (let i = 1; i < hubs.length; i++) {
    edges.push({ kind: 'Electricity', a: hubs[i - 1].id, b: hubs[i].id });
  }
  for (const hub of hubs) {
    const p = place(byId.Pylon, hub.x - 2, hub.y - 2, 0);
    if (p) edges.push({ kind: 'Electricity', a: p.id, b: hub.id });
  }

  return { entities, transports, edges, occupancy, designation };
}

// ── thumbnail ────────────────────────────────────────────────────────────────
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Renders a small JPEG preview of this map, standing in for the screenshot the game
 * embeds in a real save. Framed on the built-up area so it shows something recognisable
 * rather than empty ocean.
 */
function renderThumbnail({ mapSize, height, surface, elevation, entities, outW = 480, outH = 270 }) {
  // Frame on the centroid of what has been built.
  let cx = mapSize / 2;
  let cy = mapSize / 2;
  if (entities.length > 0) {
    let sx = 0, sy = 0;
    for (const e of entities) { sx += e.x + e.w / 2; sy += e.y + e.h / 2; }
    cx = sx / entities.length;
    cy = sy / entities.length;
  }

  const viewW = Math.min(mapSize, 240);
  const viewH = Math.min(mapSize, Math.round((viewW * outH) / outW));
  const x0 = Math.max(0, Math.min(mapSize - viewW, Math.round(cx - viewW / 2)));
  const y0 = Math.max(0, Math.min(mapSize - viewH, Math.round(cy - viewH / 2)));

  // Entity footprints, flattened to a lookup over the visible window only.
  const entityColor = new Int32Array(viewW * viewH).fill(-1);
  for (const e of entities) {
    const rgb = hexToRgb(byId[e.proto]?.color ?? '#8a8a8a');
    const packed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    for (let ty = Math.max(y0, e.y); ty < Math.min(y0 + viewH, e.y + e.h); ty++) {
      for (let tx = Math.max(x0, e.x); tx < Math.min(x0 + viewW, e.x + e.w); tx++) {
        entityColor[(ty - y0) * viewW + (tx - x0)] = packed;
      }
    }
  }

  const surfaceRgb = SURFACES.map((s) => hexToRgb(s.color));
  const rgba = new Uint8ClampedArray(outW * outH * 4);

  for (let py = 0; py < outH; py++) {
    const ty = y0 + Math.min(viewH - 1, Math.floor((py * viewH) / outH));
    for (let px = 0; px < outW; px++) {
      const tx = x0 + Math.min(viewW - 1, Math.floor((px * viewW) / outW));
      const i = ty * mapSize + tx;
      const o = (py * outW + px) * 4;

      const built = entityColor[(ty - y0) * viewW + (tx - x0)];
      let r, g, b;
      if (built >= 0) {
        r = (built >> 16) & 255; g = (built >> 8) & 255; b = built & 255;
      } else {
        const base = surfaceRgb[surface[i]] ?? [128, 128, 128];
        // Cheap hillshade: compare against the neighbour up-left of this tile.
        const back = elevation[Math.max(0, i - mapSize - 1)];
        const shade = surface[i] === SURFACE.Ocean ? 1 : 1 + (elevation[i] - back) * 6;
        const k = Math.max(0.55, Math.min(1.35, shade));
        r = base[0] * k; g = base[1] * k; b = base[2] * k;
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }

  return encodeJpeg(rgba, outW, outH, 80);
}

// ── assemble ─────────────────────────────────────────────────────────────────
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const size = Number(arg('--size', 512));
const seed = Number(arg('--seed', 7));
const out = arg('--out', 'samples/fixture.coimap');

const terrain = buildTerrain(size, seed);
const world = placeEntities(size, terrain, seed);

const planeData = { ...terrain, ...world };
const planes = Object.entries(S.PLANES)
  .filter(([name]) => planeData[name])
  .map(([name, def]) => ({ name, dtype: def.dtype, file: `${S.MEMBERS.planeDir}${name}.${def.dtype}` }));

const manifest = {
  schemaVersion: S.SCHEMA_VERSION,
  generator: 'make-fixture.mjs (synthetic)',
  generatedAt: new Date(0).toISOString(),
  game: { version: '0.8.2c', saveVersion: 287, mapName: `Synthetic Isles (${size}×${size})` },
  map: { width: size, height: size, minHeight: 0, maxHeight: 200 },
  planes,
  surfaces: SURFACES,
  deposits: DEPOSITS,
  counts: {
    entities: world.entities.length,
    transports: world.transports.length,
    edges: world.edges.length,
    protos: PROTOS.length,
  },
};

const members = [
  { name: S.MEMBERS.manifest, data: Buffer.from(JSON.stringify(manifest, null, 2)) },
  { name: S.MEMBERS.entities, data: Buffer.from(JSON.stringify(world.entities)) },
  { name: S.MEMBERS.networks, data: Buffer.from(JSON.stringify({ transports: world.transports, edges: world.edges })) },
  { name: S.MEMBERS.protos, data: Buffer.from(JSON.stringify(PROTOS)) },
  ...planes.map((p) => ({ name: p.file, data: Buffer.from(planeData[p.name].buffer) })),
];

members.push({
  name: S.MEMBERS.thumbnail,
  data: renderThumbnail({ mapSize: size, ...terrain, entities: world.entities }),
});

const zip = createZip(members);
writeFileSync(out, zip);

console.log(`\n  ${out}  ${(zip.length / 1e6).toFixed(2)} MB`);
console.log(`  map        ${size}×${size} (${(size * size).toLocaleString()} tiles)`);
console.log(`  entities   ${world.entities.length.toLocaleString()}`);
console.log(`  transports ${world.transports.length}`);
console.log(`  edges      ${world.edges.length}`);
console.log(`  planes     ${planes.map((p) => p.name).join(', ')}\n`);
