import type { BuildingType, Good, Resource } from "./goods.ts";
import type { Side } from "./exchange.ts";
import type { EconomySnapshot } from "./snapshot.ts";

/**
 * Shared contract between the sim engine, the authoritative server, the
 * settlement worker and the web client. Zero runtime deps: types only.
 *
 * Money amounts on the wire are ALWAYS integer minor units (CR cents, $ECON
 * micro) exactly as in the ledger. UI formats them; never floats on the wire.
 */

// ───────────────────────────── Intents ─────────────────────────────

/** A player-authored command. Applied atomically by `Game.apply` at the start of
 *  the next tick (Screeps/EVE intent model). Every intent is validated against
 *  the authoritative state; it either fully applies or is rejected with a reason. */
export type Intent =
  | { kind: "build"; buildingType: BuildingType; x: number; y: number }
  | { kind: "demolish"; buildingId: string }
  | { kind: "buy_land"; x: number; y: number } // CR for common tiles, $ECON for premium (mints land NFT)
  | { kind: "buy_good"; good: Good; qty: number } // company buys from goods market into inventory
  | { kind: "sell_good"; good: Good; qty: number } // company sells inventory to goods market
  | { kind: "set_sell_policy"; good: Good; mode: "auto" | "hold" } // auto = sell surplus each tick (default)
  | { kind: "buy_truck" }
  | { kind: "borrow"; amountCr: number }
  | { kind: "repay"; amountCr: number }
  | { kind: "ipo"; sharesTotal: number; floatPct: number } // floatPct 0.1..0.6
  | { kind: "set_dividend_policy"; payoutRatio: number } // 0..1 of epoch net profit
  | { kind: "place_order"; companyId: string; side: Side; priceCr: number; qty: number } // player's wallet trades shares
  | { kind: "cancel_orders"; companyId: string }
  | { kind: "stake"; amountEcon: number } // stake $ECON behind own company (production boost + veECON yield)
  | { kind: "unstake"; amountEcon: number }
  | { kind: "buy_rwa"; symbol: string; qty: number }
  | { kind: "sell_rwa"; symbol: string; qty: number }
  | { kind: "set_autopilot"; enabled: boolean } // hand the company to the NPC manager AI
  | { kind: "rename_company"; name: string };

export type IntentKind = Intent["kind"];

export interface IntentEnvelope {
  id: string; // client-generated, echoed in the result
  playerId: string; // ledger account of the player (server sets this from the auth session)
  intent: Intent;
}

export interface IntentResult {
  id: string;
  ok: boolean;
  tick: number; // tick at which it was applied / rejected
  error?: string; // human-readable rejection reason
}

// ───────────────────────────── Events ─────────────────────────────

/** Notable things that happened during a tick; feed the live ticker, toasts
 *  and the audit trail. High-frequency goods trades are aggregated into
 *  `market_flow`, never emitted per trade. */
export type GameEvent =
  | { tick: number; kind: "build_started"; companyId: string; buildingId: string; buildingType: BuildingType; tileId: string }
  | { tick: number; kind: "build_live"; companyId: string; buildingId: string; buildingType: BuildingType }
  | { tick: number; kind: "demolished"; companyId: string; buildingId: string }
  | { tick: number; kind: "land_bought"; buyer: string; tileId: string; unit: "CR" | "ECON"; price: number; nft?: string }
  | { tick: number; kind: "ipo"; companyId: string; sharesTotal: number; floatShares: number; priceCr: number; raisedCr: number }
  | { tick: number; kind: "share_trade"; companyId: string; priceCr: number; qty: number; buyer: string; seller: string }
  | { tick: number; kind: "dividend"; companyId: string; poolCr: number; perShareCr: number; paid: { account: string; amountCr: number }[] } // time-weighted holders' cuts
  | { tick: number; kind: "loan"; companyId: string; amountCr: number; rateBps: number }
  | { tick: number; kind: "repaid"; companyId: string; amountCr: number }
  | { tick: number; kind: "bankrupt"; companyId: string }
  | { tick: number; kind: "graduated"; companyId: string; marketCapCr: number } // shares now settle on-chain (marketCapCr = VWAP x totalShares)
  | { tick: number; kind: "staked"; account: string; companyId: string; amountEcon: number }
  | { tick: number; kind: "unstaked"; account: string; companyId: string; amountEcon: number }
  | { tick: number; kind: "epoch_close"; epoch: number; dividendsCr: number; yieldEcon: number; burnedEcon: number; feesEcon: number; feesExternal: boolean } // feesExternal: feesEcon observed from the real fee feed
  | { tick: number; kind: "market_flow"; good: Good; priceCr: number; bought: number; sold: number } // one per good per tick
  | { tick: number; kind: "price_alert"; good: Good; priceCr: number; pct: number } // |move| >= 10% in a tick
  | { tick: number; kind: "intent_rejected"; playerId: string; intentKind: IntentKind; error: string };

export type GameEventKind = GameEvent["kind"];

// ───────────────────────── Per-player view ─────────────────────────

/** Everything the owning player needs to run their company; never sent to
 *  other players (inventory, orders, credit score are private). */
export interface PlayerView {
  playerId: string;
  cashCr: number;
  econ: number; // $ECON minor
  stakedEcon: number;
  rwa: { symbol: string; qty: number; usd: number }[];
  holdings: { companyId: string; shares: number; lastPriceCr: number }[]; // shares in any company
  orders: { id: number; companyId: string; side: Side; priceCr: number; qty: number }[];
  company: CompanyView | null; // null until the player founds a company
  pending: { id: string; kind: IntentKind }[]; // intents queued for next tick
}

export interface CompanyView {
  id: string;
  name: string;
  hubTileId: string;
  autopilot: boolean;
  bankrupt: boolean;
  cashCr: number;
  debtCr: number;
  creditScore: number;
  maxNewLoanCr: number;
  rateBps: number; // current per-tick interest rate
  trucks: number;
  truckCapacity: number; // total weight/tick the fleet can haul
  haulDemand: number; // weight/tick the buildings need moved
  stakedEcon: number;
  boost: number; // production multiplier from staking, e.g. 0.12 = +12%
  inventory: Record<Good, number>;
  sellPolicy: Partial<Record<Good, "auto" | "hold">>;
  buildings: {
    id: string; type: BuildingType; tileId: string; x: number; y: number;
    live: boolean; liveAtTick: number; utilization: number; richness: number;
  }[];
  lastPnl: { revenue: number; inputCost: number; labor: number; energy: number; logistics: number; interest: number; net: number };
  epochProfitCr: number; // accumulated this epoch (dividend base)
  smoothedProfitCr: number;
  bookValueCr: number;
  valuationCr: number;
  isPublic: boolean;
  isOnChain: boolean;
  totalShares: number;
  floatShares: number;
  founderShares: number;
  founderLockedUntilTick: number; // -1 if not public
  dividendPayoutRatio: number;
  marketCapCr: number;
  sharePriceCr: number;
  bestBidCr: number | null;
  bestAskCr: number | null;
  /** Progress toward on-chain graduation (all three gates must be met at an epoch close). */
  graduationProgress: { epochsPublic: number; vwapCapCr: number; volumePctFloat: number };
}

// ───────────────────────── Wire protocol ─────────────────────────

/** Client → server over WebSocket. */
export type ClientMessage =
  | { type: "auth"; token: string } // session token from POST /auth/verify (SIWS) or /auth/guest
  | { type: "intent"; id: string; intent: Intent }
  | { type: "ping"; t: number };

/** Server → client over WebSocket. */
export type ServerMessage =
  | { type: "hello"; playerId: string; tick: number; ticksPerDay: number; tickMs: number; snapshot: EconomySnapshot; you: PlayerView }
  | { type: "tick"; tick: number; snapshot: EconomySnapshot; you: PlayerView; events: GameEvent[]; results: IntentResult[] }
  | { type: "result"; result: IntentResult } // immediate validation failure (malformed) before queueing
  | { type: "error"; message: string }
  | { type: "pong"; t: number };

// ───────────────────────── Epoch settlement ─────────────────────────

/** Written by the server at every epoch close; consumed by the settlement
 *  worker to build the Merkle root for on-chain claims. Amounts are $ECON
 *  minor units. `claimant` is the player's Solana pubkey (base58) when known. */
export interface EpochAllocation {
  epoch: number;
  tickClosed: number;
  allocations: { playerId: string; claimant: string | null; amountEcon: number; source: "dividend" | "yield" }[];
}

export type { EconomySnapshot, BuildingType, Good, Resource, Side };
