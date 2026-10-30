import { cr } from "./units.ts";

/** Every tradeable good in the world. */
export type Good =
  | "iron_ore" | "coal" | "crude_oil" | "wheat" | "timber" | "water"
  | "steel" | "fuel" | "planks" | "flour"
  | "machinery" | "tools" | "bread" | "furniture";

export type GoodCategory = "raw" | "intermediate" | "finished";

export interface GoodDef {
  category: GoodCategory;
  weight: number; // per-unit weight -> logistics cost
  refPrice: number; // reference price, CR minor units
}

/**
 * Reference prices are the long-run clearing anchors and MUST cover each
 * recipe's average cost at reference input prices with a 20-40% margin, or
 * that stage of the chain can never run (avg cost = inputs + energy +
 * labor/throughput; see RECIPES below):
 *   steel 17.75 -> 22, fuel 20.2 -> 25, planks 10.3 -> 13, flour 7.75 -> 10,
 *   machinery 82.75 -> 100, tools 31.5 -> 40, bread 27 -> 34, furniture 34 -> 42.
 */
export const GOODS: Record<Good, GoodDef> = {
  iron_ore:  { category: "raw", weight: 4, refPrice: cr(4) },
  coal:      { category: "raw", weight: 4, refPrice: cr(3) },
  crude_oil: { category: "raw", weight: 3, refPrice: cr(6) },
  wheat:     { category: "raw", weight: 2, refPrice: cr(2) },
  timber:    { category: "raw", weight: 5, refPrice: cr(3) },
  water:     { category: "raw", weight: 1, refPrice: cr(2) },

  steel:  { category: "intermediate", weight: 3, refPrice: cr(22) },
  fuel:   { category: "intermediate", weight: 2, refPrice: cr(25) },
  planks: { category: "intermediate", weight: 3, refPrice: cr(13) },
  flour:  { category: "intermediate", weight: 2, refPrice: cr(10) },

  machinery: { category: "finished", weight: 4, refPrice: cr(100) },
  tools:     { category: "finished", weight: 2, refPrice: cr(40) },
  bread:     { category: "finished", weight: 1, refPrice: cr(34) },
  furniture: { category: "finished", weight: 3, refPrice: cr(42) },
};

export const ALL_GOODS = Object.keys(GOODS) as Good[];

/** Goods that NPC cities consume as final demand. */
export const CONSUMER_GOODS: readonly Good[] = ["bread", "furniture", "tools", "machinery", "fuel"];

/** Natural resource a tile can host; maps to the extractor that needs it. */
export type Resource = "iron" | "coal" | "oil" | "fertile" | "forest" | "aquifer";

export type BuildingType =
  | "mine" | "coal_mine" | "oil_well" | "farm" | "forestry" | "waterworks"
  | "smelter" | "refinery" | "sawmill" | "mill"
  | "machine_factory" | "toolworks" | "bakery" | "furniture_factory";

export interface Recipe {
  /** inputs consumed per unit of throughput */
  inputs: Partial<Record<Good, number>>;
  /** outputs produced per unit of throughput */
  outputs: Partial<Record<Good, number>>;
  baseThroughput: number; // units/tick at full utilization
  laborCr: number; // wage cost per tick (CR minor)
  energyCr: number; // energy cost per unit throughput (CR minor)
  buildCostCr: number; // capex to construct
  buildTicks: number; // ticks until operational
  requiresResource?: Resource; // extractor must sit on a tile with this resource
}

export const RECIPES: Record<BuildingType, Recipe> = {
  mine:       { inputs: {}, outputs: { iron_ore: 1 }, baseThroughput: 20, laborCr: cr(30), energyCr: cr(1), buildCostCr: cr(1200), buildTicks: 6, requiresResource: "iron" },
  coal_mine:  { inputs: {}, outputs: { coal: 1 }, baseThroughput: 22, laborCr: cr(28), energyCr: cr(1), buildCostCr: cr(1100), buildTicks: 6, requiresResource: "coal" },
  oil_well:   { inputs: {}, outputs: { crude_oil: 1 }, baseThroughput: 16, laborCr: cr(40), energyCr: cr(2), buildCostCr: cr(2000), buildTicks: 8, requiresResource: "oil" },
  farm:       { inputs: {}, outputs: { wheat: 1 }, baseThroughput: 30, laborCr: cr(24), energyCr: cr(1), buildCostCr: cr(900), buildTicks: 5, requiresResource: "fertile" },
  forestry:   { inputs: {}, outputs: { timber: 1 }, baseThroughput: 18, laborCr: cr(26), energyCr: cr(1), buildCostCr: cr(1000), buildTicks: 5, requiresResource: "forest" },
  waterworks: { inputs: {}, outputs: { water: 1 }, baseThroughput: 40, laborCr: cr(18), energyCr: cr(1), buildCostCr: cr(700), buildTicks: 4, requiresResource: "aquifer" },

  smelter:  { inputs: { iron_ore: 2, coal: 1 }, outputs: { steel: 1 }, baseThroughput: 12, laborCr: cr(45), energyCr: cr(3), buildCostCr: cr(2600), buildTicks: 8 },
  refinery: { inputs: { crude_oil: 2 }, outputs: { fuel: 1 }, baseThroughput: 12, laborCr: cr(50), energyCr: cr(4), buildCostCr: cr(3000), buildTicks: 9 },
  sawmill:  { inputs: { timber: 2 }, outputs: { planks: 1 }, baseThroughput: 14, laborCr: cr(32), energyCr: cr(2), buildCostCr: cr(1600), buildTicks: 6 },
  mill:     { inputs: { wheat: 2 }, outputs: { flour: 1 }, baseThroughput: 16, laborCr: cr(28), energyCr: cr(2), buildCostCr: cr(1400), buildTicks: 6 },

  machine_factory:   { inputs: { steel: 2, fuel: 1 }, outputs: { machinery: 1 }, baseThroughput: 8, laborCr: cr(70), energyCr: cr(5), buildCostCr: cr(4200), buildTicks: 12 },
  toolworks:         { inputs: { steel: 1 }, outputs: { tools: 1 }, baseThroughput: 10, laborCr: cr(55), energyCr: cr(4), buildCostCr: cr(3200), buildTicks: 10 },
  bakery:            { inputs: { flour: 2, water: 1 }, outputs: { bread: 1 }, baseThroughput: 18, laborCr: cr(36), energyCr: cr(3), buildCostCr: cr(1800), buildTicks: 6 },
  furniture_factory: { inputs: { planks: 2 }, outputs: { furniture: 1 }, baseThroughput: 12, laborCr: cr(48), energyCr: cr(4), buildCostCr: cr(2600), buildTicks: 8 },
};

export const ALL_BUILDINGS = Object.keys(RECIPES) as BuildingType[];

/** The extractor building that harvests each natural resource. */
export const RES_OF: Record<Resource, BuildingType> = {
  iron: "mine",
  coal: "coal_mine",
  oil: "oil_well",
  fertile: "farm",
  forest: "forestry",
  aquifer: "waterworks",
};
