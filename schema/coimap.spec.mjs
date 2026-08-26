/**
 * Single source of truth for the `.coimap` format.
 *
 * `schema/generate.mjs` turns this into TypeScript (for web/) and C# (for mod/) so the
 * two sides cannot drift. Edit this file, then run `npm run schema` from the repo root.
 */

export const SCHEMA_VERSION = 1;

/** A `.coimap` file is a ZIP archive containing these members. */
export const MEMBERS = {
  manifest: 'manifest.json',
  entities: 'entities.json',
  networks: 'networks.json',
  protos: 'protos.json',
  thumbnail: 'thumbnail.jpg',
  planeDir: 'planes/',
};

export const ENUMS = {
  /** Construction / operating state of a placed entity. */
  EntityState: ['Unknown', 'Constructing', 'Operating', 'Idle', 'Paused', 'Disabled', 'Broken', 'Deconstructing'],
  /** What a transport segment carries. */
  TransportKind: ['Unknown', 'Conveyor', 'Pipe'],
  /** Kind of power/connectivity graph an edge belongs to. */
  NetworkKind: ['Electricity', 'MechanicalShaft', 'Rail'],
};

/**
 * Per-tile raster layers, stored one file per plane under `planes/`, row-major,
 * exactly `width * height` elements. Planar (not interleaved) so each layer can be
 * omitted, decoded straight into a typed array, and uploaded as its own texture.
 *
 * `optional` planes may be absent; the manifest lists what was actually written.
 *
 * Multi-byte values are little-endian. Every platform this runs on (x86 and ARM,
 * game and browser alike) is little-endian, so no byte swapping is performed.
 */
export const PLANES = {
  height:        { dtype: 'u16', optional: false, doc: 'Terrain height, game units, per tile.' },
  surface:       { dtype: 'u8',  optional: false, doc: 'Surface type slim id; index into protos.surfaces.' },
  material:      { dtype: 'u8',  optional: true,  doc: 'Topmost terrain material slim id.' },
  deposit:       { dtype: 'u8',  optional: true,  doc: 'Virtual resource id present under this tile; 0 = none.' },
  depositAmount: { dtype: 'u16', optional: true,  doc: 'Relative quantity of the deposit, 0-65535.' },
  designation:   { dtype: 'u8',  optional: true,  doc: 'Bitmask: 1=mine 2=dump 4=forestry 8=surface 16=unreachable.' },
  occupancy:     { dtype: 'u8',  optional: true,  doc: 'Non-zero where any static entity occupies the tile.' },
};

export const DESIGNATION_BITS = {
  Mine: 1, Dump: 2, Forestry: 4, Surface: 8, Unreachable: 16,
};

export const STRUCTS = {
  Manifest: [
    { name: 'schemaVersion', type: 'int',      doc: 'Bumped on any breaking format change.' },
    { name: 'generator',     type: 'string',   doc: 'Mod name and version that produced this file.' },
    { name: 'generatedAt',   type: 'string',   doc: 'ISO-8601 UTC timestamp.' },
    { name: 'game',          type: 'GameInfo' },
    { name: 'map',           type: 'MapInfo' },
    { name: 'planes',        type: 'PlaneInfo[]', doc: 'Which raster planes this file actually contains.' },
    { name: 'surfaces',      type: 'Surface[]',   doc: 'Legend for the surface plane.' },
    { name: 'deposits',      type: 'Deposit[]',   doc: 'Legend for the deposit plane.' },
    { name: 'counts',        type: 'Counts' },
  ],
  GameInfo: [
    { name: 'version',     type: 'string', doc: 'e.g. "0.8.2c".' },
    { name: 'saveVersion', type: 'int' },
    { name: 'mapName',     type: 'string' },
  ],
  MapInfo: [
    { name: 'width',  type: 'int', doc: 'Tiles along X.' },
    { name: 'height', type: 'int', doc: 'Tiles along Y.' },
    { name: 'minHeight', type: 'float', doc: 'Height plane value 0 maps to this world height.' },
    { name: 'maxHeight', type: 'float', doc: 'Height plane value 65535 maps to this world height.' },
  ],
  PlaneInfo: [
    { name: 'name',  type: 'string' },
    { name: 'dtype', type: 'string', doc: '"u8" | "u16".' },
    { name: 'file',  type: 'string', doc: 'Path inside the archive.' },
  ],
  Counts: [
    { name: 'entities',   type: 'int' },
    { name: 'transports', type: 'int' },
    { name: 'edges',      type: 'int' },
    { name: 'protos',     type: 'int' },
  ],
  /** A terrain surface type: what the `surface` plane's ids mean. */
  Surface: [
    { name: 'id',    type: 'int',    doc: 'Value stored in the surface plane.' },
    { name: 'name',  type: 'string', doc: 'Display name, e.g. "Grass".' },
    { name: 'color', type: 'string', doc: 'Base fill as "#rrggbb"; hillshading is applied on top.' },
    { name: 'water', type: 'bool',   doc: 'True for ocean and water surfaces.' },
  ],
  /** A virtual resource deposit type: what the `deposit` plane's ids mean. */
  Deposit: [
    { name: 'id',    type: 'int',    doc: 'Value stored in the deposit plane; 0 means none.' },
    { name: 'name',  type: 'string' },
    { name: 'color', type: 'string' },
  ],
  /** One placed static entity. Short field names: there may be tens of thousands. */
  Entity: [
    { name: 'id',    type: 'int',    doc: 'Stable in-game entity id.' },
    { name: 'proto', type: 'string', doc: 'Prototype id; key into protos.json.' },
    { name: 'x',     type: 'int',    doc: 'Tile X of the footprint origin.' },
    { name: 'y',     type: 'int',    doc: 'Tile Y of the footprint origin.' },
    { name: 'w',     type: 'int',    doc: 'Footprint width in tiles, after rotation.' },
    { name: 'h',     type: 'int',    doc: 'Footprint height in tiles, after rotation.' },
    { name: 'rot',   type: 'int',    doc: 'Rotation, 0-3 (quarter turns clockwise).' },
    { name: 'state', type: 'EntityState' },
  ],
  /** A conveyor or pipe run, as a polyline of tile coordinates. */
  Transport: [
    { name: 'id',     type: 'int' },
    { name: 'proto',  type: 'string' },
    { name: 'kind',   type: 'TransportKind' },
    { name: 'points', type: 'int[]', doc: 'Flat [x0,y0,x1,y1,...] tile coordinates.' },
  ],
  /** An edge in a power or rail graph, between two entity ids. */
  NetworkEdge: [
    { name: 'kind', type: 'NetworkKind' },
    { name: 'a',    type: 'int', doc: 'Entity id.' },
    { name: 'b',    type: 'int', doc: 'Entity id.' },
  ],
  Networks: [
    { name: 'transports', type: 'Transport[]' },
    { name: 'edges',      type: 'NetworkEdge[]' },
  ],
  /** Display metadata for one prototype. */
  Proto: [
    { name: 'id',       type: 'string' },
    { name: 'name',     type: 'string', doc: 'Human-readable display name.' },
    { name: 'category', type: 'string', doc: 'Grouping used for colouring and filters.' },
    { name: 'color',    type: 'string', doc: 'Fallback fill as "#rrggbb".' },
    { name: 'w',        type: 'int',    doc: 'Unrotated footprint width.' },
    { name: 'h',        type: 'int',    doc: 'Unrotated footprint height.' },
  ],
};

/** Stable colours per category, shared by the exporter and the renderer. */
export const CATEGORY_COLORS = {
  Mining:      '#c2703a',
  Smelting:    '#d4553a',
  Chemistry:   '#7d55b8',
  Manufacture: '#3f7fb8',
  Power:       '#e0b13a',
  Storage:     '#6b7a86',
  Transport:   '#4a9e6b',
  Farming:     '#5aa03c',
  Settlement:  '#d189b0',
  Fluid:       '#3aa9c2',
  Other:       '#8a8a8a',
};
