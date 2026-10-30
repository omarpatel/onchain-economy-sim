import type { BuildingType, Resource } from "@econ-sim/sim/goods";

/** Layout: each tile is TILE units square; the world is centered on the origin. */
export const TILE = 2.2;

/** Ring layout around the playable map (Chebyshev tile distance `d` outside the map edge):
 *  1..TOWN_RING is the surrounding town, beyond it nature out to MAP_MARGIN; the sea
 *  starts SEA_START tiles beyond the south (+z) edge. */
export const TOWN_RING = 14;
export const MAP_MARGIN = 40;
export const SEA_START = 15;
/** Sea surface height (world y); the town's quay wall drops from 0 to below it. */
export const SEA_LEVEL = -0.35;

/** Chebyshev distance of tile (x, y) outside a width × height map (0 inside). */
export function ringDist(x: number, y: number, width: number, height: number): number {
  return Math.max(0, -x, x - width + 1, -y, y - height + 1);
}

/**
 * Streets run on every other grid line, so a city block is 2×2 parcels and
 * every parcel touches two streets. Asphalt + two sidewalk bands.
 */
export const ROAD = {
  block: 2,
  width: 0.5,
  asphalt: 0.32,
  walk: 0.09,
  asphaltColor: "#4f4a44",
  walkColor: "#b3aa95",
  /** raised kerb stone along the asphalt edge: lighter than the walk so the street edge reads from afar */
  kerbColor: "#d6cdb8",
  /** centre-line dashes and zebra stripes */
  paintColor: "#ece6d4",
  laneOffset: 0.085,
} as const;

/** Grass tones the ground noise blends between: a muted meadow (dark → light), not a lawn under noon sun. */
export const GRASS = ["#5f8c45", "#729c50", "#86ac5d"] as const;
/** Dry, straw-coloured patches mixed into the meadow and the shade grass darkens toward under tree cover. */
export const GRASS_DRY = "#a9a46a";
export const GRASS_SHADE = "#4b7238";

/** Natural read of each deposit; used by the minimap/landing map and as the ground tint under features. */
export const RES_COLOR: Record<Resource, string> = {
  iron: "#8d9096",
  coal: "#44444a",
  oil: "#2f2a33",
  fertile: "#c49a4a",
  forest: "#3f7d3a",
  aquifer: "#4fb3c9",
};

export const RES_LABEL: Record<Resource, string> = {
  iron: "Iron ore",
  coal: "Coal seam",
  oil: "Oil field",
  fertile: "Fertile soil",
  forest: "Forest",
  aquifer: "Aquifer",
};

export const BARREN_COLOR = "#86b45f";

/** Parcel outline colours: yours is mint, everyone else is bone white; premium land is a quiet gold. */
export const OUTLINE = { mine: "#7dffb3", other: "#e6e2d6", premium: "#d9b24a", hover: "#ffffff" } as const;

/** Green → yellow → red heat ramp used by every analysis layer. */
export const HEAT = ["#3ddc97", "#facc15", "#ef4444"] as const;

/** Sandstone wall range (light → dark); each building picks a stable shade between them. */
export const WALL = ["#d9cfb8", "#c9bea4"] as const;

/** Roof palette each building picks from by tile hash: terracottas, browns, slates and a pale sandstone. */
export const ROOF = ["#b5532f", "#a3492b", "#b86a45", "#7b5440", "#8c6a52", "#646c76", "#56606b", "#d6ccb2"] as const;

/** Per-building 3D style: UI accent (doors/machinery on the model, swatches in menus),
 *  silhouette height, label, and which animated/ambient parts the geometry carries. */
export interface BuildingStyle {
  color: string;
  height: number;
  label: string;
  smoke: boolean;
  rotor: "blade" | "pumpjack" | "wheel" | "fan" | null;
}

export const BUILDING_STYLE: Record<BuildingType, BuildingStyle> = {
  // extractors — low, earthy
  mine:       { color: "#8f7a5a", height: 2.6, label: "Iron Mine", smoke: false, rotor: "wheel" },
  coal_mine:  { color: "#3a3d44", height: 2.4, label: "Coal Mine", smoke: false, rotor: null },
  oil_well:   { color: "#5b4b7a", height: 3.2, label: "Oil Well", smoke: false, rotor: "pumpjack" },
  farm:       { color: "#b7411e", height: 1.6, label: "Farm", smoke: false, rotor: null },
  forestry:   { color: "#3f7d3a", height: 2.0, label: "Forestry", smoke: false, rotor: null },
  waterworks: { color: "#3aa4c8", height: 1.8, label: "Waterworks", smoke: false, rotor: "wheel" },
  // processors — mid, industrial
  smelter:  { color: "#d0622a", height: 3.6, label: "Smelter", smoke: true, rotor: null },
  refinery: { color: "#c99a2e", height: 3.8, label: "Refinery", smoke: true, rotor: null },
  sawmill:  { color: "#8a5a3a", height: 2.2, label: "Sawmill", smoke: false, rotor: "blade" },
  mill:     { color: "#b8934a", height: 3.0, label: "Grain Mill", smoke: false, rotor: null },
  // factories — tall, bright
  machine_factory:   { color: "#2f8f8a", height: 3.4, label: "Machine Factory", smoke: false, rotor: "fan" },
  toolworks:         { color: "#2e7fb8", height: 3.0, label: "Toolworks", smoke: false, rotor: "fan" },
  bakery:            { color: "#c9556e", height: 2.4, label: "Bakery", smoke: false, rotor: null },
  furniture_factory: { color: "#9a6a44", height: 2.8, label: "Furniture Factory", smoke: false, rotor: null },
};

/** Convert tile grid coords to centered world XZ. */
export function tileToWorld(x: number, y: number, width: number, height: number): [number, number] {
  return [(x - width / 2) * TILE, (y - height / 2) * TILE];
}

/** Convert a centered world XZ back to grid tile coords. */
export function worldToTile(wx: number, wz: number, width: number, height: number): [number, number] {
  return [Math.round(wx / TILE + width / 2), Math.round(wz / TILE + height / 2)];
}

/** World XZ of grid corner (i, j) — the point shared by tiles (i-1..i, j-1..j). */
export function cornerToWorld(i: number, j: number, width: number, height: number): [number, number] {
  return [(i - width / 2) * TILE - TILE / 2, (j - height / 2) * TILE - TILE / 2];
}

/** Small deterministic hash → [0, 1) so scatter/variation is stable across ticks and reloads. */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Trees standing on an in-map tile, shared by the forest scatter weight and
 * the darker floor under it: forests only. Open parcels stay clear so they
 * read as available land, and the ring beyond the map belongs to the town
 * and the landscape (`tile` undefined → none).
 */
export function treeCount(_x: number, _y: number, tile?: { res: Resource | null; building: unknown; owner: string | null }): number {
  if (!tile || tile.building) return 0;
  return tile.res === "forest" ? 4 : 0;
}

/** Shared, render-loop-mutated player position for the minimap + camera. */
export interface PlayerPos {
  x: number;
  z: number;
  heading: number;
}
