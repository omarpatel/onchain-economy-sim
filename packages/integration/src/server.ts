import type { ServerEpoch } from "./settlement.ts";

/** HTTP client for the authoritative game server (packages/server). */
export class GameServer {
  readonly baseUrl: string;
  private readonly adminToken: string;

  constructor(baseUrl: string, adminToken: string) {
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetch(path, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** `fetch` with the target URL folded into connection errors (Node's own message is just "fetch failed"). */
  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, init);
    } catch (e) {
      const cause = (e as Error).cause;
      throw new Error(`${init.method ?? "GET"} ${url}: ${cause instanceof Error ? cause.message : (e as Error).message}`);
    }
  }

  async health(): Promise<{ tick: number }> {
    const h = await this.get<{ tick: number }>("/api/health");
    if (!h || typeof h.tick !== "number") throw new Error("GET /api/health returned no tick");
    return h;
  }

  /** Newest closed epoch, or null before the first epoch closes. */
  async latestEpoch(): Promise<ServerEpoch | null> {
    return this.get<ServerEpoch>("/api/epochs/latest");
  }

  async epoch(n: number): Promise<ServerEpoch | null> {
    return this.get<ServerEpoch>(`/api/epochs/${n}`);
  }

  private async admin(path: string, body: unknown): Promise<void> {
    const res = await this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.adminToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  /** Feeds `game.rwa.setQuotesUsd(quotes, econUsd)`. */
  postOracle(quotes: Record<string, number>, econUsd?: number): Promise<void> {
    return this.admin("/admin/oracle", econUsd === undefined ? { quotes } : { quotes, econUsd });
  }

  /** Feeds `game.chain.setExternalCreatorFees(econMinorPerTick)`. */
  postCreatorFees(econMinorPerTick: number): Promise<void> {
    return this.admin("/admin/creator-fees", { econMinorPerTick });
  }

  /** Feeds the server's on-chain stake table (yield rows are pro-rata to these, never to in-sim stake). */
  postOnchainStakes(stakes: Record<string, number>, asOfSlot: number): Promise<void> {
    return this.admin("/admin/onchain-stakes", { stakes, asOfSlot });
  }
}
