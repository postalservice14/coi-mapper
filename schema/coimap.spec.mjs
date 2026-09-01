/**
 * Single source of truth for the `.coimap` format.
 *
 * `schema/generate.mjs` turns this into TypeScript (for web/) and C# (for mod/) so the
 * two sides cannot drift. Edit this file, then run `npm run schema` from the repo root.
 */

export const SCHEMA_VERSION = 2;

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
  /**
   * What sort of machine a vehicle census row counts. `Unknown` leads so the C# default
   * serialises as a real name, and so the exporter's leftover pass has somewhere to put a
   * class the typed walks did not recognise.
   *
   * Declaration order is also the order the UI groups rows in, because the exporter sorts
   * by the ordinal. Reordering this list silently reorders the panel.
   */
  VehicleKind: ['Unknown', 'Truck', 'Excavator', 'TreeHarvester', 'TreePlanter', 'Locomotive', 'CargoWagon'],
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
  surface:       { dtype: 'u8',  optional: false, doc: 'Natural ground: topmost material slim id + 1, 0 = ocean. Index into manifest.surfaces. Despite the name this is NOT player-placed paving — see tileSurface.' },
  material:      { dtype: 'u8',  optional: true,  doc: 'Topmost terrain material slim id.' },
  tileSurface:   { dtype: 'u8',  optional: true,  doc: 'Player-placed surface slim id; 0 = unpaved. Index into manifest.tileSurfaces.' },
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
    { name: 'tileSurfaces',  type: 'TileSurface[]', doc: 'Legend for the tileSurface plane. Absent in files written before that plane existed.' },
    { name: 'deposits',      type: 'Deposit[]',   doc: 'Legend for the deposit plane.' },
    { name: 'vehicles',      type: 'VehicleCensus', doc: 'The fleet, counted per prototype. Absent in files written before this existed.' },
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
  /**
   * A player-placed surface — concrete, brick, metal flooring: what the `tileSurface`
   * plane's ids mean. Distinct from `Surface`, which is natural ground.
   */
  TileSurface: [
    { name: 'id',    type: 'int',    doc: 'Value stored in the tileSurface plane; 0 means unpaved.' },
    { name: 'name',  type: 'string', doc: 'Display name, e.g. "Concrete".' },
    { name: 'color', type: 'string', doc: 'Fill as "#rrggbb"; hillshading is applied on top.' },
  ],
  /** A virtual resource deposit type: what the `deposit` plane's ids mean. */
  Deposit: [
    { name: 'id',    type: 'int',    doc: 'Value stored in the deposit plane; 0 means none.' },
    { name: 'name',  type: 'string' },
    { name: 'color', type: 'string' },
  ],
  /**
   * How many of one kind of machine the world holds.
   *
   * Deliberately self-contained rather than a key into protos.json: that dictionary is a
   * by-product of the static-entity walk, so no vehicle prototype ever appears in it.
   */
  VehicleCount: [
    { name: 'proto', type: 'string', doc: 'Prototype id. NOT a key into protos.json — see above.' },
    { name: 'name',  type: 'string', doc: 'Display name, e.g. "Haul truck (dump) (Diesel)". The fuel variant is part of the game\'s own name.' },
    { name: 'kind',  type: 'VehicleKind' },
    { name: 'count', type: 'int' },
  ],
  /**
   * Every mobile machine in the world, counted. Road vehicles and train cars only —
   * cargo ships are not counted.
   */
  VehicleCensus: [
    {
      name: 'exported',
      type: 'bool',
      doc:
        'False when this export carries no census at all — either written by a mod build ' +
        'from before vehicles were exported, or the vehicle managers would not resolve. ' +
        'Distinct from a world that genuinely has none, which exports with an empty types list.',
    },
    {
      name: 'types',
      type: 'VehicleCount[]',
      doc:
        'One row per prototype, ordered by kind (the VehicleKind declaration order), then ' +
        'count descending, then name. The exporter fixes the order so two exports of the ' +
        'same world agree byte for byte.',
    },
    { name: 'vehicles',  type: 'int', doc: 'Total road vehicles.' },
    { name: 'trainCars', type: 'int', doc: 'Total locomotives and cargo wagons.' },
    { name: 'trains',    type: 'int', doc: 'Assembled trains; the cars counted above belong to these.' },
    { name: 'limit',     type: 'int', doc: "The game's vehicle quota. 0 when unknown." },
    { name: 'limitLeft', type: 'int', doc: 'Quota remaining.' },
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
    {
      name: 'tiles',
      type: 'int[]',
      doc:
        'Occupied tiles as flat [dx,dy,...] offsets from (x,y). Empty when the entity ' +
        'fills its w*h box exactly, which is the common case for machines. Conveyors ' +
        'and pipes snake, so their bounding box is mostly empty and this lists the ' +
        'tiles they really cover.',
    },
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
