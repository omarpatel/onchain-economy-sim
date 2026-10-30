import { NextResponse, type NextRequest } from "next/server";
import { newDemoGame, type Game } from "@econ-sim/sim/engine";
import { snapshotGame, type EconomySnapshot } from "@econ-sim/sim/snapshot";
import { SERVER_URL } from "../../../lib/client/config.ts";

export const dynamic = "force-dynamic";

const MIN_TICK_MS = 2000;
const UPSTREAM_TIMEOUT_MS = 5000;

/**
 * Public economy feed for the landing page. Proxies the tick server's
 * `GET /api/economy` (ETag / If-None-Match forwarded) and, when the server is
 * unreachable, serves one process-wide demo economy advanced at most one tick
 * per 2 s — flagged with `x-econ-source: sandbox`.
 */
let demo: { game: Game; lastTickAt: number; snap: EconomySnapshot } | null = null;

function demoSnapshot(): EconomySnapshot {
  const now = Date.now();
  if (!demo) {
    const game = newDemoGame();
    demo = { game, lastTickAt: now, snap: snapshotGame(game) };
    return demo.snap;
  }
  if (now - demo.lastTickAt >= MIN_TICK_MS) {
    demo.game.tick();
    demo.lastTickAt = now;
    demo.snap = snapshotGame(demo.game);
  }
  return demo.snap;
}

export async function GET(req: NextRequest) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const ifNoneMatch = req.headers.get("if-none-match");
    const upstream = await fetch(`${SERVER_URL}/api/economy`, {
      headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
      signal: ctl.signal,
      cache: "no-store",
    });
    const etag = upstream.headers.get("etag");
    const headers: Record<string, string> = { "cache-control": "no-store", "x-econ-source": "live" };
    if (etag) headers.etag = etag;
    if (upstream.status === 304) return new NextResponse(null, { status: 304, headers });
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    headers["content-type"] = "application/json; charset=utf-8";
    return new NextResponse(await upstream.text(), { status: 200, headers });
  } catch {
    return NextResponse.json(demoSnapshot(), { headers: { "cache-control": "no-store", "x-econ-source": "sandbox" } });
  } finally {
    clearTimeout(timer);
  }
}
