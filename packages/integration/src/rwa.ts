/**
 * RWA marks for the in-game equities desk (AAPL, TSLA, NVDA, MSFT, SPY) plus SOL/USD.
 *
 * Primary source: Pyth Hermes `GET /v2/updates/price/latest?ids[]=…&parsed=true`.
 * Since the Pyth Core upgrade Hermes requires `Authorization: Bearer <PYTH_API_KEY>`
 * (unauthenticated calls return 401; https://docs.pyth.network/price-feeds/core/fetch-price-updates).
 * Feed ids below come from https://pyth.network/developers/price-feed-ids and are
 * re-checked by `verifyFeedIds()` against the keyless metadata endpoint
 * `GET /v2/price_feeds?query=<symbol>&asset_type=<equity|crypto>`.
 *
 * Fallback (no key or 401): Jupiter Price v3 (`https://lite-api.jup.ag/price/v3?ids=…`;
 * v2 and price.jup.ag/v6 are gone) quoting Backed's xStocks tokens — official
 * Solana mints from https://xstocks.com/products (`addresses.solana`). Jupiter's v3
 * response carries `stockData.price` (the underlying equity's last price) for
 * xStocks, which we prefer over the on-chain token price; SOL uses wrapped SOL.
 *
 * COMPLIANCE: these are real securities. Quotes only — the desk itself must be
 * KYC/geofence gated before exposing real RWA trading.
 */
export interface RwaFeedDef {
  /** Pyth price feed id (hex, no 0x). */
  pythId: string;
  pythAssetType: "equity" | "crypto";
  /** Pyth `attributes.symbol` used to validate the id. */
  pythSymbol: string;
  /** Solana mint quoted by Jupiter in the fallback path. */
  jupMint: string;
}

export const RWA_FEEDS: Record<string, RwaFeedDef> = {
  AAPL: {
    pythId: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    pythAssetType: "equity",
    pythSymbol: "Equity.US.AAPL/USD",
    jupMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", // AAPLx
  },
  TSLA: {
    pythId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    pythAssetType: "equity",
    pythSymbol: "Equity.US.TSLA/USD",
    jupMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", // TSLAx
  },
  NVDA: {
    pythId: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    pythAssetType: "equity",
    pythSymbol: "Equity.US.NVDA/USD",
    jupMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", // NVDAx
  },
  MSFT: {
    pythId: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    pythAssetType: "equity",
    pythSymbol: "Equity.US.MSFT/USD",
    jupMint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", // MSFTx
  },
  SPY: {
    pythId: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    pythAssetType: "equity",
    pythSymbol: "Equity.US.SPY/USD",
    jupMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", // SPYx
  },
  SOL: {
    pythId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    pythAssetType: "crypto",
    pythSymbol: "Crypto.SOL/USD",
    jupMint: "So11111111111111111111111111111111111111112",
  },
};

export interface RwaQuote {
  symbol: string;
  priceUsd: number;
  /** Publish time (ms since epoch). */
  ts: number;
  source: "pyth" | "jupiter";
}

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface JupPriceV3 {
  usdPrice?: number;
  decimals?: number;
  stockData?: { price?: number };
}

export class RwaFeed {
  private readonly hermesUrl: string;
  private readonly apiKey: string | null;
  private readonly jupUrl: string;
  private readonly cache: Record<string, RwaQuote> = {};

  constructor(opts: { hermesUrl: string; apiKey: string | null; jupUrl: string }) {
    this.hermesUrl = opts.hermesUrl;
    this.apiKey = opts.apiKey;
    this.jupUrl = opts.jupUrl;
  }

  /** Refresh every feed; Pyth when a key is configured and accepted, otherwise Jupiter. */
  async refresh(): Promise<RwaQuote[]> {
    let quotes: RwaQuote[] | null = null;
    if (this.apiKey) {
      try {
        quotes = await this.fromPyth();
      } catch (e) {
        console.warn(`[rwa] pyth hermes failed (${(e as Error).message}); falling back to jupiter`);
      }
    }
    quotes ??= await this.fromJupiter();
    for (const q of quotes) this.cache[q.symbol] = q;
    return quotes;
  }

  quote(symbol: string): RwaQuote | undefined {
    return this.cache[symbol];
  }

  async fromPyth(): Promise<RwaQuote[]> {
    const ids = Object.values(RWA_FEEDS).map((f) => `ids[]=${f.pythId}`).join("&");
    const res = await fetch(`${this.hermesUrl}/v2/updates/price/latest?${ids}&parsed=true`, {
      headers: { accept: "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    });
    if (!res.ok) throw new Error(`hermes ${res.status} ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as { parsed?: HermesParsed[] };
    const byId: Record<string, HermesParsed> = {};
    for (const p of body.parsed ?? []) byId[p.id.replace(/^0x/, "")] = p;

    const out: RwaQuote[] = [];
    for (const [symbol, def] of Object.entries(RWA_FEEDS)) {
      const p = byId[def.pythId];
      if (!p) continue;
      out.push({ symbol, priceUsd: Number(p.price.price) * 10 ** p.price.expo, ts: p.price.publish_time * 1000, source: "pyth" });
    }
    if (out.length === 0) throw new Error("hermes returned no parsed prices");
    return out;
  }

  async fromJupiter(): Promise<RwaQuote[]> {
    const mints = Object.values(RWA_FEEDS).map((f) => f.jupMint);
    const res = await fetch(`${this.jupUrl}?ids=${mints.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`jupiter price ${res.status}`);
    const data = (await res.json()) as Record<string, JupPriceV3 | null>;
    const now = Date.now();
    const out: RwaQuote[] = [];
    for (const [symbol, def] of Object.entries(RWA_FEEDS)) {
      const row = data[def.jupMint];
      const price = row?.stockData?.price ?? row?.usdPrice;
      if (typeof price !== "number" || !(price > 0)) continue;
      out.push({ symbol, priceUsd: price, ts: now, source: "jupiter" });
    }
    if (out.length === 0) throw new Error("jupiter returned no prices");
    return out;
  }
}

/** USD price of an arbitrary SPL mint via Jupiter Price v3 (used for $ECON/USD). */
export async function jupiterUsdPrice(jupUrl: string, mint: string): Promise<{ usd: number; decimals: number | null } | null> {
  const res = await fetch(`${jupUrl}?ids=${mint}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jupiter price ${res.status}`);
  const data = (await res.json()) as Record<string, JupPriceV3 | null>;
  const row = data[mint];
  if (!row || typeof row.usdPrice !== "number" || !(row.usdPrice > 0)) return null;
  return { usd: row.usdPrice, decimals: typeof row.decimals === "number" ? row.decimals : null };
}

/**
 * Check each configured feed id against Hermes' keyless metadata endpoint.
 * Returns the symbols whose id is unknown or maps to a different instrument.
 */
export async function verifyFeedIds(hermesUrl: string): Promise<{ symbol: string; problem: string }[]> {
  const problems: { symbol: string; problem: string }[] = [];
  for (const [symbol, def] of Object.entries(RWA_FEEDS)) {
    const url = `${hermesUrl}/v2/price_feeds?query=${encodeURIComponent(symbol)}&asset_type=${def.pythAssetType}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      problems.push({ symbol, problem: `metadata ${res.status}` });
      continue;
    }
    const feeds = (await res.json()) as { id: string; attributes: { symbol: string } }[];
    const hit = feeds.find((f) => f.id.replace(/^0x/, "") === def.pythId);
    if (!hit) problems.push({ symbol, problem: `id ${def.pythId} not returned for query "${symbol}"` });
    else if (hit.attributes.symbol !== def.pythSymbol) problems.push({ symbol, problem: `id maps to ${hit.attributes.symbol}` });
  }
  return problems;
}
