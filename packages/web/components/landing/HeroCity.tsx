"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgXToneMapping } from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Selection } from "@react-three/postprocessing";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { Terrain } from "../three/Terrain.tsx";
import { Features } from "../three/Features.tsx";
import { Buildings, Rotors, Smoke } from "../three/Buildings.tsx";
import { Agents } from "../three/Agents.tsx";
import { DayNight } from "../three/DayNight.tsx";
import { Effects } from "../three/Effects.tsx";
import { deriveBuilds } from "../three/builds.ts";
import { buildRoads } from "../three/roads.ts";
import { Sky } from "../three/Sky.tsx";
import { Landscape } from "../three/Landscape.tsx";
import { Town } from "../three/Town.tsx";

/** Radians per second of the showcase orbit (one lap ≈ 3.5 min). */
const ORBIT_SPEED = 0.03;
const ORBIT_RADIUS = 62;
/** Low enough, aimed a little above the ground, that the top of the frame catches the skyline, mountains and a sliver of sky. */
const ORBIT_HEIGHT = 24;
const LOOK_Y = 9;
/** Fraction of the canvas width the city is pushed right, leaving the left for the headline. */
const SHIFT = 0.16;
/** Bright afternoon, so the sandstone pops behind the headline; dusk and the lamps follow about 1.5 min later. */
const START_PHASE = 0.48;

const noop = () => {};

/** Slow cinematic orbit around the map centre, framed off-centre with a view offset. */
function Orbit() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    camera.setViewOffset(size.width, size.height, -size.width * SHIFT, 0, size.width, size.height);
    return () => camera.clearViewOffset();
  }, [camera, size.width, size.height]);
  useFrame(({ clock }) => {
    const a = clock.elapsedTime * ORBIT_SPEED + 0.9;
    camera.position.set(Math.cos(a) * ORBIT_RADIUS, ORBIT_HEIGHT, Math.sin(a) * ORBIT_RADIUS);
    camera.lookAt(0, LOOK_Y, 0);
  });
  return null;
}

/**
 * Landing hero: the real game scene (terrain, streets, buildings, trucks,
 * day/night, post stack) rendered from the public economy snapshot, with no
 * game UI or input. Rendering pauses while the hero is scrolled out of view.
 */
export default function HeroCity({ snap }: { snap: EconomySnapshot }) {
  const firstSeen = useRef(new Map<string, number>());
  const builds = useMemo(() => deriveBuilds(snap, firstSeen.current), [snap]);
  const roads = useMemo(() => buildRoads(snap), [snap]);
  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={wrap} className="pointer-events-none h-full w-full">
      <Canvas
        shadows
        frameloop={visible ? "always" : "never"}
        dpr={[1, 1.5]}
        gl={{ toneMapping: AgXToneMapping, toneMappingExposure: 1.0, antialias: false, powerPreference: "high-performance", stencil: false }}
        camera={{ fov: 30, near: 1, far: 400, position: [ORBIT_RADIUS, ORBIT_HEIGHT, 0] }}
        style={{ width: "100%", height: "100%" }}
      >
        <Selection>
          <DayNight start={START_PHASE} />
          <Sky />
          <Terrain snap={snap} youCompany={null} onTileClick={noop} />
          <Landscape width={snap.world.width} height={snap.world.height} />
          <Features snap={snap} roads={roads} />
          <Town width={snap.world.width} height={snap.world.height} />
          <Buildings builds={builds} youCompany={null} onTileClick={noop} />
          <Rotors builds={builds} />
          <Smoke builds={builds} />
          <Agents roads={roads} />
          <Orbit />
          <Effects />
        </Selection>
      </Canvas>
    </div>
  );
}
