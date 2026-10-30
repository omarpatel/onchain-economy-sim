import { CONFIG } from "./config.ts";
import type { Resource } from "./goods.ts";
import type { Rng } from "./rng.ts";
import { cr, econ } from "./units.ts";

export interface Tile {
  id: string;
  x: number;
  y: number;
  resources: Partial<Record<Resource, number>>; // resource -> richness (0.5..2.0)
  premium: boolean; // premium tiles are bought with $ECON (on-chain land NFT)
  priceCr: number; // common land price (CR minor)
  priceEcon: number; // premium land price ($ECON minor)
  ownerId: string | null; // company id, or an account id for investor-held NFT land
}

const RESOURCES: readonly Resource[] = ["iron", "coal", "oil", "fertile", "forest", "aquifer"];

/** Terrain is regenerated from the seed; only ownership is state. */
export type MapState = { id: string; owner: string }[];

export class WorldMap {
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[] = [];
  private index: Record<string, Tile> = {};

  constructor(rng: Rng) {
    this.width = CONFIG.world.width;
    this.height = CONFIG.world.height;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const t: Tile = {
          id: `${x},${y}`,
          x, y,
          resources: {},
          premium: false,
          priceCr: cr(600 + rng.int(0, 400)),
          priceEcon: 0,
          ownerId: null,
        };
        this.tiles.push(t);
        this.index[t.id] = t;
      }
    }

    // Seed resource clusters: pick centers, spread richness with falloff.
    // Cluster counts were tuned on a 24x24 map and scale with area.
    const areaScale = (this.width * this.height) / (24 * 24);
    for (const res of RESOURCES) {
      const clusters = Math.max(1, Math.round(rng.int(2, 4) * areaScale));
      for (let c = 0; c < clusters; c++) {
        const cx = rng.int(0, this.width - 1);
        const cy = rng.int(0, this.height - 1);
        const radius = rng.int(2, 4);
        const peak = rng.float(1.2, 2.0);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const tile = this.at(cx + dx, cy + dy);
            if (!tile) continue;
            const dist = Math.hypot(dx, dy);
            if (dist > radius) continue;
            const richness = peak * (1 - dist / (radius + 1));
            if (richness < 0.4) continue;
            tile.resources[res] = Math.max(tile.resources[res] ?? 0, +richness.toFixed(2));
          }
        }
      }
    }

    // Premium tiles: the richest multi-resource tiles become on-chain premium
    // land; one per 64 tiles so the $ECON land sink scales with the map.
    const target = Math.round((this.width * this.height) / 64);
    const rich = this.tiles
      .map((t) => ({ t, resCount: Object.keys(t.resources).length, totalRich: Object.values(t.resources).reduce((a, b) => a + b, 0) }))
      .filter((x) => x.resCount >= 2)
      .sort((a, z) => z.totalRich - a.totalRich || z.resCount - a.resCount);
    for (const { t, totalRich } of rich.slice(0, target)) {
      t.premium = true;
      t.priceEcon = econ(CONFIG.chain.premiumLandBaseEcon + Math.round(totalRich * 8));
    }
  }

  at(x: number, y: number): Tile | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.index[`${x},${y}`];
  }

  tile(id: string): Tile {
    const t = this.index[id];
    if (!t) throw new Error(`map: unknown tile ${id}`);
    return t;
  }

  /** Euclidean distance in tiles -> used for logistics cost. */
  distance(a: Tile, b: Tile): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Free tiles that can host an extractor for the given resource. */
  freeResourceTiles(res: Resource): Tile[] {
    return this.tiles.filter((t) => !t.ownerId && (t.resources[res] ?? 0) > 0);
  }

  freePlainTiles(): Tile[] {
    return this.tiles.filter((t) => !t.ownerId && !t.premium);
  }

  ownedBy(ownerId: string): Tile[] {
    return this.tiles.filter((t) => t.ownerId === ownerId);
  }

  toJSON(): MapState {
    const out: MapState = [];
    for (const t of this.tiles) if (t.ownerId) out.push({ id: t.id, owner: t.ownerId });
    return out;
  }

  restore(state: MapState): void {
    for (const t of this.tiles) t.ownerId = null;
    for (const o of state) this.tile(o.id).ownerId = o.owner;
  }
}
