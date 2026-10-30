"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { TopBar } from "./TopBar.tsx";
import { Drawer } from "./Drawer.tsx";
import { Ticker } from "./Ticker.tsx";
import { Hotbar } from "./Hotbar.tsx";
import { Minimap } from "./Minimap.tsx";
import { Layers } from "./Layers.tsx";
import { Hud } from "./Hud.tsx";
import { PLACE_SEARCH_ID } from "./PlaceSearch.tsx";
import { Toasts } from "../ui/index.tsx";
import { ErrorReport } from "../three/ErrorReport.tsx";
import type { PlayerPos } from "../three/world-style.ts";
import { useWorld } from "../../lib/world.ts";
import { useUi } from "../../lib/store.ts";

// WebGL is client-only; the shell around it renders immediately.
const Scene = dynamic(() => import("../three/Scene.tsx").then((m) => m.Scene), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Compiling shaders…</div>,
});

/** Top bar / center canvas + right drawer / bottom ticker. Requires a WorldContext. */
export function PlayShell() {
  const { snap } = useWorld();
  const minimap = useUi((s) => s.minimap);
  const playerPos = useRef<PlayerPos>({ x: 0, z: 0, heading: 0 });

  // Phones start on the map: drawer and minimap closed (the drawer pops up as a sheet on selection).
  // Done after mount so the server-rendered shell and the first client render agree.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 768px)").matches) useUi.setState({ drawerOpen: false, minimap: false });
  }, []);

  // Global hotkeys: Esc unwinds build menu → placement → interior → heat layer → selection/step-out;
  // B toggles the build menu, / focuses place search, Tab toggles the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ui = useUi.getState();
      if (e.code === "Escape") {
        if (ui.buildMenu) ui.setBuildMenu(false);
        else if (ui.buildMode) ui.setBuildMode(null);
        else if (ui.interiorTile) ui.setInterior(null);
        else if (ui.layer !== "world") ui.setLayer("world");
        else { ui.selectTile(null); ui.requestStepOut(); }
      } else if (e.code === "KeyB") {
        ui.setBuildMenu(!ui.buildMenu);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById(PLACE_SEARCH_ID)?.focus();
      } else if (e.code === "Tab") {
        e.preventDefault();
        ui.toggleDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-obsidian text-slate-200">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <ErrorReport>
            <Scene playerPos={playerPos} />
          </ErrorReport>
          <Toasts />
          <Hotbar />
          <Layers />
          <Hud />
          {minimap && <Minimap snap={snap} playerPos={playerPos} />}
        </main>
        <Drawer />
      </div>
      <Ticker />
    </div>
  );
}
