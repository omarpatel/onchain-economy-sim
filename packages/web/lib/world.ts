"use client";

import { createContext, useContext } from "react";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { GameEvent, Intent, IntentResult, PlayerView } from "@econ-sim/sim/protocol";

/**
 * The single source of truth every play-screen component reads from.
 *
 * Providers (sandbox = in-browser Game, online = authoritative tick server) live
 * in `lib/client/**` and publish a `WorldState`; the render layer and the
 * drawer only ever consume it through `useWorld()`.
 *
 * - `snap`   public economy snapshot for the latest tick (minor-unit money)
 * - `you`    the private per-player view, `null` while unauthenticated / spectating
 * - `events` events emitted by recent ticks, newest last (bounded ring)
 * - `send`   queue an intent; resolves with the engine's accept/reject result
 * - `latencyMs` last ping/pong round trip (online only), `null` when unknown
 */
export interface WorldState {
  snap: EconomySnapshot;
  you: PlayerView | null;
  events: GameEvent[];
  tick: number;
  connected: boolean;
  mode: "sandbox" | "online";
  latencyMs: number | null;
  send(intent: Intent): Promise<IntentResult>;
}

export const WorldContext = createContext<WorldState | null>(null);

export function useWorld(): WorldState {
  const w = useContext(WorldContext);
  if (!w) throw new Error("useWorld() must be used inside a WorldContext provider");
  return w;
}
