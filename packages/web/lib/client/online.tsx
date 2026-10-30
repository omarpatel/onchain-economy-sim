"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import type { ClientMessage, GameEvent, Intent, IntentResult, PlayerView, ServerMessage } from "@econ-sim/sim/protocol";
import { WorldContext, type WorldState } from "../world.ts";
import { useUi } from "../store.ts";
import { WS_URL } from "./config.ts";
import { useSession } from "./auth.ts";
import { LoginGate } from "../../components/shell/LoginGate.tsx";

const EVENT_RING = 300;
const INTENT_TIMEOUT_MS = 10_000;
const PING_MS = 5000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 10_000;
/** Server close code for an unknown/expired session token (no point retrying). */
const CLOSE_BAD_SESSION = 4003;

interface Live {
  snap: EconomySnapshot;
  you: PlayerView;
  events: GameEvent[];
  tick: number;
}

interface Pending {
  resolve: (r: IntentResult) => void;
  timer: number;
}

/**
 * Authoritative `WorldState` from the tick server over WebSocket.
 *
 * Lifecycle: session (localStorage `econ.session`, else the login gate) →
 * `auth` → `hello` seeds the state → every `tick` replaces `snap`/`you`,
 * appends events and settles the intents it carries results for. Drops
 * reconnect with exponential backoff and the next `hello` resyncs the state.
 */
export function OnlineProvider({ children, fallback }: {
  children: ReactNode;
  fallback: (progress: number, label: string) => ReactNode;
}) {
  const session = useSession((s) => s.session);
  const hydrated = useSession((s) => s.hydrated);
  const hydrate = useSession((s) => s.hydrate);
  useEffect(() => hydrate(), [hydrate]);

  const [live, setLive] = useState<Live | null>(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [status, setStatus] = useState("Connecting to the world");
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const headTick = useRef(0);
  const seq = useRef(0);

  const token = session?.token;
  const playerId = session?.playerId;

  useEffect(() => {
    // A new session (guest → wallet, sign-out) must not keep showing the previous player's world.
    setLive(null);
    setConnected(false);
    if (!token || !playerId) return;
    let closed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let pinger: number | undefined;
    let welcomed = false;
    const toast = useUi.getState().toast;

    const failPending = (error: string): void => {
      for (const [id, p] of pending.current) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, tick: headTick.current, error });
      }
      pending.current.clear();
    };
    const settle = (r: IntentResult): void => {
      const p = pending.current.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.current.delete(r.id);
      p.resolve(r);
    };
    const wsSend = (msg: ClientMessage): void => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    /** "Found your company" moment: focus the HQ and greet once per page load. */
    const welcome = (you: PlayerView, snap: EconomySnapshot): void => {
      if (welcomed) return;
      welcomed = true;
      const co = you.company;
      if (!co) return;
      const hq = snap.world.tiles.find((t) => t.id === co.hubTileId);
      if (hq) useUi.getState().focusTile(hq.x, hq.y);
      const key = `econ.welcomed:${you.playerId}`;
      const first = !window.localStorage.getItem(key);
      window.localStorage.setItem(key, "1");
      toast("ok", first
        ? `${co.name} founded — your HQ is at ${co.hubTileId}. Build on the tiles around it.`
        : `Welcome back — ${co.name} HQ at ${co.hubTileId}`);
    };

    const onMessage = (msg: ServerMessage): void => {
      switch (msg.type) {
        case "hello": {
          attempt = 0;
          headTick.current = msg.tick;
          setConnected(true);
          setStatus("Connected");
          // Resync: the fresh snapshot replaces whatever we had; the event ring is kept.
          setLive((prev) => ({ snap: msg.snapshot, you: msg.you, events: prev?.events ?? [], tick: msg.tick - 1 }));
          wsSend({ type: "ping", t: performance.now() });
          clearInterval(pinger);
          pinger = window.setInterval(() => wsSend({ type: "ping", t: performance.now() }), PING_MS);
          welcome(msg.you, msg.snapshot);
          return;
        }
        case "tick": {
          headTick.current = msg.tick + 1;
          const rejectedHere = new Set<string>();
          for (const r of msg.results) {
            if (!r.ok && r.error) rejectedHere.add(r.error);
            settle(r);
          }
          // Rejections that were not answers to one of our in-flight sends (e.g. from another tab).
          for (const e of msg.events) {
            if (e.kind === "intent_rejected" && e.playerId === playerId && !rejectedHere.has(e.error)) toast("error", `${e.intentKind} rejected — ${e.error}`);
          }
          setLive((prev) => ({
            snap: msg.snapshot,
            you: msg.you,
            events: [...(prev?.events ?? []), ...msg.events].slice(-EVENT_RING),
            tick: msg.tick,
          }));
          return;
        }
        case "result":
          settle(msg.result);
          return;
        case "pong":
          setLatencyMs(Math.max(0, Math.round(performance.now() - msg.t)));
          return;
        case "error":
          toast("error", msg.message);
          return;
      }
    };

    const connect = (): void => {
      if (closed) return;
      setStatus(attempt === 0 ? "Connecting to the world" : `Reconnecting (attempt ${attempt + 1})`);
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => wsSend({ type: "auth", token });
      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(ev.data) as ServerMessage; } catch { return; }
        onMessage(msg);
      };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        clearInterval(pinger);
        setConnected(false);
        setLatencyMs(null);
        failPending("Disconnected from the server");
        if (closed) return;
        if (ev.code === CLOSE_BAD_SESSION) {
          toast("error", "Your session has expired — sign in again");
          useSession.getState().clear();
          return;
        }
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
        attempt++;
        setStatus(`Reconnecting in ${Math.ceil(delay / 1000)} s`);
        retry = window.setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(pinger);
      failPending("Connection closed");
      if (ws) { ws.onclose = null; ws.close(); }
      wsRef.current = null;
    };
  }, [token, playerId]);

  const send = useCallback((intent: Intent): Promise<IntentResult> => {
    const id = `w${(++seq.current).toString(36)}${Date.now().toString(36)}`;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ id, ok: false, tick: headTick.current, error: "Not connected to the server" });
    }
    return new Promise<IntentResult>((resolve) => {
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        resolve({ id, ok: false, tick: headTick.current, error: "No response from the server after 10 s" });
      }, INTENT_TIMEOUT_MS);
      pending.current.set(id, { resolve, timer });
      ws.send(JSON.stringify({ type: "intent", id, intent } satisfies ClientMessage));
    });
  }, []);

  const value = useMemo<WorldState | null>(() => live && {
    ...live,
    connected,
    mode: "online",
    latencyMs,
    send,
  }, [live, connected, latencyMs, send]);

  if (!hydrated) return <>{fallback(0, "Loading session")}</>;
  if (!session) return <LoginGate />;
  if (!value) return <>{fallback(connected ? 0.9 : 0.4, status)}</>;
  return <WorldContext.Provider value={value}>{children}</WorldContext.Provider>;
}
