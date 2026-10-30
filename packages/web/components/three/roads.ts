import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { ROAD, cornerToWorld } from "./world-style.ts";

type Tile = EconomySnapshot["world"]["tiles"][number];

/** One tile-length of street on a grid line; `traffic` is 0..1 haul intensity. */
export interface Segment {
  /** start corner */
  i: number;
  j: number;
  horizontal: boolean;
  wx: number;
  wz: number;
  traffic: number;
}

/** A street corner with at least one segment; bit mask of connected sides. */
export interface Node {
  i: number;
  j: number;
  wx: number;
  wz: number;
  n: boolean;
  s: boolean;
  e: boolean;
  w: boolean;
}

/** A truck's round trip: world-space polyline from the company HQ corner to a building corner. */
export interface Route {
  companyId: string;
  /** the served building's tile */
  tileId: string;
  points: [number, number][];
  length: number;
}

export interface RoadNet {
  segments: Segment[];
  nodes: Node[];
  routes: Route[];
  /** street corners where a lamp stands (every intersection) */
  lamps: [number, number][];
  /** whether the edge starting at corner (i, j) going +x (horizontal) or +z carries a street */
  hasRoad(i: number, j: number, horizontal: boolean): boolean;
}

/**
 * Streets exist on every other grid line (ROAD.block) and only where they
 * border a developed parcel (owned or built), plus the corridors trucks use
 * between each company's HQ and its buildings — so the outskirts stay green.
 */
export function buildRoads(snap: EconomySnapshot): RoadNet {
  const { width, height, tiles } = snap.world;
  const B = ROAD.block;
  const hKey = (i: number, j: number) => j * (width + 1) + i;
  const vKey = (i: number, j: number) => i * (height + 1) + j;
  const h = new Map<number, number>(); // horizontal edge (i,j)→(i+1,j), j on a street line
  const v = new Map<number, number>(); // vertical edge (i,j)→(i,j+1), i on a street line
  const onLine = (k: number) => k % B === 0;

  for (const t of tiles) {
    if (!t.owner && !t.building) continue;
    // top/bottom edges lie on lines y and y+1; left/right on x and x+1
    if (onLine(t.y)) h.set(hKey(t.x, t.y), 0);
    if (onLine(t.y + 1)) h.set(hKey(t.x, t.y + 1), 0);
    if (onLine(t.x)) v.set(vKey(t.x, t.y), 0);
    if (onLine(t.x + 1)) v.set(vKey(t.x + 1, t.y), 0);
  }

  // Access corner of a tile: the block corner (both coords on street lines) that is one of its own corners.
  const access = (t: Tile): [number, number] => [onLine(t.x) ? t.x : t.x + 1, onLine(t.y) ? t.y : t.y + 1];

  const routes: Route[] = [];
  const hq = new Map<string, Tile>();
  for (const t of tiles) if (t.hq && t.owner) hq.set(t.owner, t);
  for (const t of tiles) {
    const b = t.building;
    if (!b || t.hq) continue;
    const home = hq.get(b.companyId);
    if (!home) continue;
    const [ax, ay] = access(home);
    const [bx, by] = access(t);
    const pts: [number, number][] = [];
    let length = 0;
    const push = (i: number, j: number) => {
      const [wx, wz] = cornerToWorld(i, j, width, height);
      if (pts.length) { const [px, pz] = pts[pts.length - 1]; length += Math.hypot(wx - px, wz - pz); }
      pts.push([wx, wz]);
    };
    push(ax, ay);
    // L-path: along the HQ's street line in x, then along the building's line in y
    const sx = Math.sign(bx - ax);
    for (let i = ax; i !== bx; i += sx) { h.set(hKey(Math.min(i, i + sx), ay), (h.get(hKey(Math.min(i, i + sx), ay)) ?? 0) + 1); }
    if (bx !== ax) push(bx, ay);
    const sy = Math.sign(by - ay);
    for (let j = ay; j !== by; j += sy) { v.set(vKey(bx, Math.min(j, j + sy)), (v.get(vKey(bx, Math.min(j, j + sy))) ?? 0) + 1); }
    if (by !== ay) push(bx, by);
    if (pts.length > 1) routes.push({ companyId: b.companyId, tileId: t.id, points: pts, length });
  }

  let max = 1;
  for (const c of h.values()) max = Math.max(max, c);
  for (const c of v.values()) max = Math.max(max, c);

  const segments: Segment[] = [];
  const nodeMap = new Map<number, Node>();
  const node = (i: number, j: number): Node => {
    const k = j * (width + 2) + i;
    let n = nodeMap.get(k);
    if (!n) {
      const [wx, wz] = cornerToWorld(i, j, width, height);
      n = { i, j, wx, wz, n: false, s: false, e: false, w: false };
      nodeMap.set(k, n);
    }
    return n;
  };
  for (const [k, c] of h) {
    const j = Math.floor(k / (width + 1));
    const i = k % (width + 1);
    const [wx, wz] = cornerToWorld(i, j, width, height);
    segments.push({ i, j, horizontal: true, wx: wx + (cornerToWorld(i + 1, j, width, height)[0] - wx) / 2, wz, traffic: c / max });
    node(i, j).e = true;
    node(i + 1, j).w = true;
  }
  for (const [k, c] of v) {
    const i = Math.floor(k / (height + 1));
    const j = k % (height + 1);
    const [wx, wz] = cornerToWorld(i, j, width, height);
    segments.push({ i, j, horizontal: false, wx, wz: wz + (cornerToWorld(i, j + 1, width, height)[1] - wz) / 2, traffic: c / max });
    node(i, j).s = true;
    node(i, j + 1).n = true;
  }
  const nodes = [...nodeMap.values()];
  const lamps: [number, number][] = [];
  for (const n of nodes) {
    const ways = +n.n + +n.s + +n.e + +n.w;
    if (ways >= 3 || (ways === 2 && n.n !== n.s)) lamps.push([n.wx, n.wz]);
  }
  return {
    segments, nodes, routes, lamps,
    hasRoad: (i, j, horizontal) => (horizontal ? h.has(hKey(i, j)) : v.has(vKey(i, j))),
  };
}
