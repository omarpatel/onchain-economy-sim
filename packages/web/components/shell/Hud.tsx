"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useUi } from "../../lib/store.ts";
import { useWorld } from "../../lib/world.ts";

/** Frames counted over this window before the readout updates. */
const FPS_WINDOW_MS = 500;

/** Bottom-left of the canvas: fps pill plus keycap hints for whatever Esc / the keyboard does right now. */
export function Hud() {
  const fps = useFps();
  const buildMenu = useUi((s) => s.buildMenu);
  const buildMode = useUi((s) => s.buildMode);
  const walkMode = useUi((s) => s.walkMode);
  const layer = useUi((s) => s.layer);
  const selected = useUi((s) => s.selectedTile);
  const interior = useUi((s) => s.interiorTile);
  const { snap } = useWorld();
  const selectedHasBuilding = !!selected && !!snap.world.tiles.find((t) => t.id === selected)?.building;

  let hints: [string, string][];
  if (buildMenu) hints = [["Esc", "close"], ["B", "close"]];
  else if (buildMode) hints = [["Click", "place"], ["Esc", "cancel"]];
  else if (walkMode) hints = [["WASD", "walk"], ["Shift", "run"], ["F", "drive"]];
  else if (interior) hints = [["Esc", "step out"], ["I", "exit interior"]];
  else if (layer !== "world") hints = [["Esc", "exit layer"]];
  else if (selectedHasBuilding) hints = [["I", "look inside"], ["Esc", "step out"], ["B", "build"], ["Tab", "panel"]];
  else if (selected) hints = [["Esc", "step out"], ["B", "build"], ["Tab", "panel"]];
  else hints = [["B", "build"], ["/", "search"], ["Tab", "panel"], ["Esc", "step out"]];

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2 text-[10px]">
      <span className="glass rounded-md px-2 py-1 font-mono tabular-nums text-slate-300">{fps} fps</span>
      <span className="hidden items-center gap-2.5 md:flex">
        {hints.map(([key, what]) => <Hint key={key + what} k={key}>{what}</Hint>)}
      </span>
    </div>
  );
}

function Hint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-slate-300 [text-shadow:0_1px_2px_rgba(0,0,0,.8)]">
      <kbd className="rounded bg-white px-1 py-px font-sans text-[9px] font-extrabold leading-tight text-black shadow">{k}</kbd>
      {children}
    </span>
  );
}

/** Display frame rate from requestAnimationFrame, re-rendering only twice a second. */
function useFps(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let start = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      frames++;
      if (now - start >= FPS_WINDOW_MS) {
        setFps(Math.round((frames * 1000) / (now - start)));
        frames = 0;
        start = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}
