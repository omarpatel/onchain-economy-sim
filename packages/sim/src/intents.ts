import { CONFIG } from "./config.ts";
import type { Company } from "./company.ts";
import type { Game } from "./engine.ts";
import { ALL_BUILDINGS, ALL_GOODS, type BuildingType, type Good } from "./goods.ts";
import * as ops from "./ops.ts";
import type { Intent, IntentEnvelope, IntentResult } from "./protocol.ts";
import { cleanName } from "./text.ts";

const INTENT_KINDS: Record<Intent["kind"], true> = {
  build: true, demolish: true, buy_land: true, buy_good: true, sell_good: true, set_sell_policy: true,
  buy_truck: true, borrow: true, repay: true, ipo: true, set_dividend_policy: true, place_order: true,
  cancel_orders: true, stake: true, unstake: true, buy_rwa: true, sell_rwa: true, set_autopilot: true,
  rename_company: true,
};

/**
 * Apply one player intent against the authoritative state. Every intent is
 * fully validated first (ownership, funds, tile rules, lockups, ranges) and
 * either applies atomically or is rejected with a human-readable reason.
 * Money moves only through the ledger; share and RWA intents act on the
 * PLAYER's wallet, everything else on the player's company.
 */
export function applyIntent(game: Game, env: IntentEnvelope): IntentResult {
  const tick = game.ledger.tick;
  const reject = (error: string): IntentResult => {
    game.emit({ tick, kind: "intent_rejected", playerId: env.playerId, intentKind: env.intent?.kind, error });
    return { id: env.id, ok: false, tick, error };
  };
  const player = game.player(env.playerId);
  if (!player) return reject("unknown player");
  const intent = env.intent;
  if (!intent || typeof intent !== "object" || !(intent.kind in INTENT_KINDS)) return reject("unknown intent kind");

  const error = dispatch(game, env.playerId, player.companyId ? game.company(player.companyId) : undefined, intent);
  return error === null ? { id: env.id, ok: true, tick } : reject(error);
}

function dispatch(game: Game, playerId: string, co: Company | undefined, intent: Intent): ops.OpResult {
  switch (intent.kind) {
    // ── wallet-level intents (no company needed) ──
    case "place_order": {
      const target = game.company(intent.companyId);
      if (!target) return `unknown company ${intent.companyId}`;
      if (!target.isPublic) return `${target.name} is not public`;
      if (intent.side !== "bid" && intent.side !== "ask") return "side must be bid or ask";
      const why = game.exchange.rejectReason(target.id, playerId, intent.side, intent.priceCr, intent.qty);
      if (why) return why;
      game.exchange.place(target.id, playerId, intent.side, intent.priceCr, intent.qty);
      return null;
    }
    case "cancel_orders": {
      const target = game.company(intent.companyId);
      if (!target) return `unknown company ${intent.companyId}`;
      if (game.exchange.cancelAll(target.id, playerId) === 0) return "no resting orders to cancel";
      return null;
    }
    case "buy_rwa": {
      if (!game.rwa.isTicker(intent.symbol)) return `unknown RWA symbol ${intent.symbol}`;
      if (!Number.isInteger(intent.qty) || intent.qty <= 0) return "qty must be a positive integer";
      const cost = game.rwa.quoteBuy(intent.symbol, intent.qty);
      const have = game.ledger.balance(playerId, "ECON");
      if (have < cost) return `insufficient $ECON: need ${cost}, have ${have}`;
      game.rwa.buy(playerId, intent.symbol, intent.qty);
      return null;
    }
    case "sell_rwa": {
      if (!game.rwa.isTicker(intent.symbol)) return `unknown RWA symbol ${intent.symbol}`;
      if (!Number.isInteger(intent.qty) || intent.qty <= 0) return "qty must be a positive integer";
      const held = game.rwa.position(playerId, intent.symbol);
      if (held < intent.qty) return `only ${held} ${intent.symbol} held`;
      if (!game.rwa.sell(playerId, intent.symbol, intent.qty)) return "desk cannot settle the sale right now";
      return null;
    }
  }

  if (!co) return "player has no company";

  switch (intent.kind) {
    case "build": {
      if (!(ALL_BUILDINGS as readonly string[]).includes(intent.buildingType)) return `unknown building type ${intent.buildingType}`;
      const tile = game.map.at(intent.x, intent.y);
      if (!tile) return `no tile at ${intent.x},${intent.y}`;
      return ops.buildOn(game, co, intent.buildingType as BuildingType, tile);
    }
    case "demolish":
      return ops.demolish(game, co, intent.buildingId);
    case "buy_land": {
      const tile = game.map.at(intent.x, intent.y);
      if (!tile) return `no tile at ${intent.x},${intent.y}`;
      return ops.buyLand(game, co, tile, playerId);
    }
    case "buy_good":
      if (!isGood(intent.good)) return `unknown good ${intent.good}`;
      return ops.buyGood(game, co, intent.good, intent.qty);
    case "sell_good":
      if (!isGood(intent.good)) return `unknown good ${intent.good}`;
      return ops.sellGood(game, co, intent.good, intent.qty);
    case "set_sell_policy":
      if (!isGood(intent.good)) return `unknown good ${intent.good}`;
      if (intent.mode !== "auto" && intent.mode !== "hold") return "mode must be auto or hold";
      if (intent.mode === "auto") delete co.sellPolicy[intent.good];
      else co.sellPolicy[intent.good] = "hold";
      return null;
    case "buy_truck":
      return ops.buyTruck(game, co);
    case "borrow":
      return ops.borrow(game, co, intent.amountCr);
    case "repay":
      return ops.repay(game, co, intent.amountCr);
    case "ipo":
      return ops.ipo(game, co, intent.sharesTotal, intent.floatPct);
    case "set_dividend_policy":
      if (!(typeof intent.payoutRatio === "number" && intent.payoutRatio >= 0 && intent.payoutRatio <= 1)) return "payoutRatio must be in [0, 1]";
      co.dividendPayoutRatio = intent.payoutRatio;
      return null;
    case "stake":
      return ops.stake(game, co, playerId, intent.amountEcon);
    case "unstake":
      return ops.unstake(game, co, playerId, intent.amountEcon);
    case "set_autopilot":
      if (typeof intent.enabled !== "boolean") return "enabled must be a boolean";
      co.autopilot = intent.enabled;
      return null;
    case "rename_company": {
      const max = CONFIG.company.maxNameLength;
      const name = cleanName(intent.name, Number.MAX_SAFE_INTEGER);
      if (name.length < 1 || name.length > max) return `name must be 1-${max} printable characters`;
      co.name = name;
      game.ledger.get(co.account).label = name;
      return null;
    }
  }
  return "unknown intent kind";
}

function isGood(g: string): g is Good {
  return (ALL_GOODS as readonly string[]).includes(g);
}
