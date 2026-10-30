"use client";

import { useCallback, useMemo, useRef } from "react";
import { AgXToneMapping } from "three";
import { Canvas } from "@react-three/fiber";
import { KeyboardControls, type KeyboardControlsEntry } from "@react-three/drei";
import { Selection } from "@react-three/postprocessing";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { Terrain } from "./Terrain.tsx";
import { Buildings, Rotors, Smoke } from "./Buildings.tsx";
import { Ghost, HoverLabel, SelectionProxy, checkBuild } from "./Overlays.tsx";
import { RtsCamera } from "./RtsCamera.tsx";
import { Effects } from "./Effects.tsx";
import { Player } from "./Player.tsx";
import { DayNight } from "./DayNight.tsx";
import { Sky } from "./Sky.tsx";
import { Agents } from "./Agents.tsx";
import { Flows } from "./Flows.tsx";
import { Features } from "./Features.tsx";
import { Landscape } from "./Landscape.tsx";
import { Town } from "./Town.tsx";
import { Labels } from "./Labels.tsx";
import { Popups } from "./Popups.tsx";
import { Interior } from "./Interior.tsx";
import { ViewStatsProbe } from "./ViewStats.tsx";
import { deriveBuilds } from "./builds.ts";
import { buildRoads } from "./roads.ts";
import { BUILDING_STYLE, TILE, type PlayerPos } from "./world-style.ts";
import { useWorld } from "../../lib/world.ts";
import { useUi } from "../../lib/store.ts";
import { sound } from "../../lib/sound.ts";

const KEYMAP: KeyboardControlsEntry[] = [
  { name: "forward", keys: ["ArrowUp", "KeyW"] },
  { name: "back", keys: ["ArrowDown", "KeyS"] },
  { name: "left", keys: ["ArrowLeft", "KeyA"] },
  { name: "right", keys: ["ArrowRight", "KeyD"] },
  { name: "run", keys: ["ShiftLeft", "ShiftRight"] },
  { name: "turnL", keys: ["KeyQ"] },
  { name: "turnR", keys: ["KeyE"] },
  { name: "enter", keys: ["KeyF"] },
];

type Tile = EconomySnapshot["world"]["tiles"][number];

/** The 3D world. Fills its parent; all UI chrome lives in the shell around it. */
export function Scene({ playerPos }: { playerPos: { current: PlayerPos } }) {
  const { snap, you, send } = useWorld();
  const walkMode = useUi((s) => s.walkMode);
  const firstSeen = useRef(new Map<string, number>());
  const builds = useMemo(() => deriveBuilds(snap, firstSeen.current), [snap]);
  const blocked = useMemo(() => new Set(builds.map((b) => b.tileId)), [builds]);
  const roads = useMemo(() => buildRoads(snap), [snap]);
  const bound = (snap.world.width / 2) * TILE - TILE;
  const tileById = useMemo(() => {
    const m: Record<string, Tile> = {};
    for (const t of snap.world.tiles) m[t.id] = t;
    return m;
  }, [snap.world.tiles]);

  const onTileClick = useCallback((tile: Tile) => {
    const ui = useUi.getState();
    if (ui.buildMode) {
      const type = ui.buildMode;
      const check = checkBuild(type, tile, you);
      if (!check.ok) { sound.play("error"); ui.toast("error", check.reasons[0]); return; }
      void send({ kind: "build", buildingType: type, x: tile.x, y: tile.y }).then((r) => {
        if (r.ok) { sound.play("place"); ui.toast("ok", `${BUILDING_STYLE[type].label} under construction at (${tile.x},${tile.y})`); ui.setBuildMode(null); }
        else { sound.play("error"); ui.toast("error", r.error ?? "Build rejected"); }
      });
      return;
    }
    ui.selectTile(tile.id);
    ui.selectCompany(tile.owner);
    ui.focusTile(tile.x, tile.y);
  }, [send, you]);

  return (
    <KeyboardControls map={KEYMAP}>
      <Canvas
        shadows
        dpr={[1, 1.5]}
        gl={{ toneMapping: AgXToneMapping, toneMappingExposure: 1.0, antialias: false, powerPreference: "high-performance", stencil: false }}
        camera={{ fov: 30, near: 1, far: 700, position: [0, 64, 49] }}
        style={{ width: "100%", height: "100%" }}
        resize={{ scroll: false }}
        onPointerMissed={() => { const ui = useUi.getState(); if (!ui.buildMode) ui.selectTile(null); }}
      >
        <Selection>
          <DayNight />
          <Sky />
          <Terrain snap={snap} youCompany={you?.company?.id ?? null} onTileClick={onTileClick} />
          <Landscape width={snap.world.width} height={snap.world.height} />
          <Features snap={snap} roads={roads} />
          <Town width={snap.world.width} height={snap.world.height} />
          <Buildings builds={builds} youCompany={you?.company?.id ?? null} onTileClick={(id) => { const t = tileById[id]; if (t) onTileClick(t); }} />
          <Rotors builds={builds} />
          <Smoke builds={builds} />
          <Ghost snap={snap} you={you} />
          <SelectionProxy snap={snap} />
          <HoverLabel snap={snap} />
          <Labels snap={snap} youCompany={you?.company?.id ?? null} />
          <Popups snap={snap} youCompany={you?.company ?? null} />
          <Interior snap={snap} />
          <Agents roads={roads} />
          <Flows snap={snap} you={you} roads={roads} />
          <ViewStatsProbe snap={snap} roads={roads} />
          {walkMode && <Player blocked={blocked} width={snap.world.width} height={snap.world.height} bound={bound} playerPos={playerPos} />}
          <RtsCamera width={snap.world.width} height={snap.world.height} enabled={!walkMode} />
          <Effects />
        </Selection>
      </Canvas>
    </KeyboardControls>
  );
}
