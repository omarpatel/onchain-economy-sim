"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Game } from "@econ-sim/sim/engine";
import { snapshotGame, type EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { GameEvent, PlayerView } from "@econ-sim/sim/protocol";
import { WorldContext, type WorldState } from "./world.ts";

export interface SandboxOpts {
  players?: number;
  npcs?: number;
  investors?: number;
  warmupTicks?: number;
  tickMs?: number;
  seed?: number;
}

const PLAYER_ID = "you";
const EVENT_RING = 240;
const WARMUP_CHUNK = 8; // ticks per idle slice; keeps the splash responsive

interface Live {
  snap: EconomySnapshot;
  you: PlayerView;
  events: GameEvent[];
  tick: number;
}

/**
 * Local, offline `WorldState` provider: runs the economy in the browser and
 * applies intents synchronously via `Game.apply`. Warmup is chunked across
 * idle callbacks so hydration is never blocked. The online provider (tick
 * server WebSocket) replaces this component at the page root; nothing below
 * it changes.
 */
export function SandboxProvider({ children, fallback, opts = {} }: {
  children: ReactNode;
  fallback: (progress: number) => ReactNode;
  opts?: SandboxOpts;
}) {
  const { players = 8, npcs = 18, investors = 8, warmupTicks = 200, tickMs = 800, seed } = opts;
  const gameRef = useRef<Game | null>(null);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<Live | null>(null);

  // Boot + chunked warmup.
  useEffect(() => {
    let cancelled = false;
    const game = seed === undefined ? new Game() : new Game(seed);
    game.boot({ players, npcs, investors });
    let done = 0;
    const schedule = (fn: () => void) => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 50 });
      else setTimeout(fn, 0);
    };
    const step = () => {
      if (cancelled) return;
      const n = Math.min(WARMUP_CHUNK, warmupTicks - done);
      for (let i = 0; i < n; i++) game.tick();
      done += n;
      setProgress(done / warmupTicks);
      if (done < warmupTicks) return schedule(step);
      const you = game.joinPlayer(PLAYER_ID, "You");
      gameRef.current = game;
      setState({ snap: snapshotGame(game), you, events: [], tick: game.headTick });
    };
    schedule(step);
    return () => { cancelled = true; gameRef.current = null; };
  }, [players, npcs, investors, warmupTicks, seed]);

  // Live ticking.
  const booted = state !== null;
  useEffect(() => {
    if (!booted) return;
    const id = setInterval(() => {
      const game = gameRef.current;
      if (!game) return;
      const out = game.tick();
      setState((prev) => ({
        snap: snapshotGame(game),
        you: game.playerView(PLAYER_ID),
        events: [...(prev?.events ?? []), ...out.events].slice(-EVENT_RING),
        tick: out.tick,
      }));
    }, tickMs);
    return () => clearInterval(id);
  }, [booted, tickMs]);

  const seq = useRef(0);
  const value = useMemo<WorldState | null>(() => {
    if (!state) return null;
    return {
      ...state,
      connected: true,
      mode: "sandbox",
      latencyMs: null,
      send: async (intent) => {
        const game = gameRef.current;
        const id = `i${++seq.current}`;
        if (!game) return { id, ok: false, tick: state.tick, error: "World is not running" };
        const result = game.apply({ id, playerId: PLAYER_ID, intent });
        // Reflect the applied change immediately instead of waiting for the next tick.
        setState((prev) => prev && { ...prev, snap: snapshotGame(game), you: game.playerView(PLAYER_ID) });
        return result;
      },
    };
  }, [state]);

  if (!value) return <>{fallback(progress)}</>;
  return <WorldContext.Provider value={value}>{children}</WorldContext.Provider>;
}
