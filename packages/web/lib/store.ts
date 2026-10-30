"use client";

import { create } from "zustand";
import type { BuildingType } from "@econ-sim/sim/goods";
import { sound } from "./sound.ts";

export type DrawerTab = "inspect" | "company" | "market" | "exchange" | "bank" | "chain" | "ledger";

export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
}

export interface FocusRequest {
  x: number;
  y: number;
  /** monotonically increasing so identical coordinates still retrigger */
  nonce: number;
}

/** Map overlay selected in the Layers menu. `world` is the plain scene. */
export type Layer = "world" | "ownership" | "price" | "richness" | "utilization" | "traffic" | "logistics";

export const LAYERS: { id: Layer; label: string; hint: string; legend: [string, string] | null }[] = [
  { id: "world", label: "World", hint: "Plain view of the city.", legend: null },
  { id: "ownership", label: "Ownership", hint: "Parcels tinted by owning company. Mint is yours.", legend: null },
  { id: "price", label: "Land price", hint: "Asking price per tile, cheap → expensive.", legend: ["Cheap", "Expensive"] },
  { id: "richness", label: "Resource richness", hint: "Deposit richness under each tile.", legend: ["Barren", "Rich"] },
  { id: "utilization", label: "Utilization", hint: "How hard each building is running this tick.", legend: ["Idle", "Flat out"] },
  { id: "traffic", label: "Traffic", hint: "Haul intensity on each street: trucks routed HQ ↔ buildings.", legend: ["Quiet", "Packed"] },
  { id: "logistics", label: "Logistics", hint: "Every company's haul routes, thicker where more freight moves, and what each plant makes.", legend: null },
];

/** Aggregates over the tiles currently inside the camera frustum; published by the scene at ~4 Hz. */
export interface ViewStats {
  tiles: number;
  /** mean asking price, CR minor units */
  priceCr: number;
  /** mean deposit richness (0..2) */
  richness: number;
  /** mean utilization across live buildings in view (0..1) */
  utilization: number;
  /** live buildings in view */
  buildings: number;
  /** mean haul intensity on streets in view (0..1) */
  traffic: number;
}

export const EMPTY_VIEW_STATS: ViewStats = { tiles: 0, priceCr: 0, richness: 0, utilization: 0, buildings: 0, traffic: 0 };

/**
 * Transient UI state shared between the DOM shell and the three scene. Kept
 * out of React context so the 3D hover path (per-frame pointer events) never
 * re-renders the drawer, and the drawer never re-renders the canvas.
 */
interface UiStore {
  hoverTile: string | null;
  selectedTile: string | null;
  selectedCompany: string | null;
  selectedGood: string | null;
  drawerTab: DrawerTab;
  drawerOpen: boolean;
  buildMode: BuildingType | null;
  /** build picker open (hotbar hammer / B); Esc closes it before anything else */
  buildMenu: boolean;
  walkMode: boolean;
  minimap: boolean;
  soundOn: boolean;
  focus: FocusRequest | null;
  /** nonce: the RTS camera dollies back out to the overview when this changes */
  stepOut: number;
  layer: Layer;
  /** tile whose building is shown as a cutaway interior (roof lifted); null = normal city view. Esc exits it first. */
  interiorTile: string | null;
  viewStats: ViewStats;
  toasts: Toast[];

  setHover(id: string | null): void;
  selectTile(id: string | null): void;
  selectCompany(id: string | null): void;
  selectGood(good: string | null): void;
  setTab(tab: DrawerTab): void;
  toggleDrawer(): void;
  setBuildMode(type: BuildingType | null): void;
  setBuildMenu(open: boolean): void;
  toggleWalk(): void;
  toggleMinimap(): void;
  toggleSound(): void;
  focusTile(x: number, y: number): void;
  requestStepOut(): void;
  setLayer(layer: Layer): void;
  setViewStats(stats: ViewStats): void;
  setInterior(tileId: string | null): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;
let focusSeq = 0;

export const useUi = create<UiStore>((set, get) => ({
  hoverTile: null,
  selectedTile: null,
  selectedCompany: null,
  selectedGood: null,
  drawerTab: "inspect",
  drawerOpen: true,
  buildMode: null,
  buildMenu: false,
  walkMode: false,
  minimap: true,
  soundOn: false,
  focus: null,
  stepOut: 0,
  layer: "world",
  interiorTile: null,
  viewStats: EMPTY_VIEW_STATS,
  toasts: [],

  setHover: (id) => {
    if (get().hoverTile === id) return;
    if (id) sound.play("hover");
    set({ hoverTile: id });
  },
  selectTile: (id) => set(id ? { selectedTile: id, drawerTab: "inspect", drawerOpen: true } : { selectedTile: null, interiorTile: null }),
  selectCompany: (id) => set({ selectedCompany: id }),
  selectGood: (good) => set({ selectedGood: good }),
  setTab: (tab) => set({ drawerTab: tab, drawerOpen: true }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setBuildMode: (type) => set({ buildMode: type, walkMode: false }),
  setBuildMenu: (open) => set(open ? { buildMenu: true, walkMode: false } : { buildMenu: false }),
  toggleWalk: () => set((s) => ({ walkMode: !s.walkMode, buildMode: null, buildMenu: false })),
  toggleMinimap: () => set((s) => ({ minimap: !s.minimap })),
  toggleSound: () => {
    const on = !get().soundOn;
    sound.setMuted(!on);
    if (on) sound.play("hover");
    set({ soundOn: on });
  },
  focusTile: (x, y) => set({ focus: { x, y, nonce: ++focusSeq } }),
  requestStepOut: () => set((s) => ({ stepOut: s.stepOut + 1, focus: null })),
  setLayer: (layer) => set({ layer }),
  setViewStats: (viewStats) => set({ viewStats }),
  setInterior: (interiorTile) => set({ interiorTile }),
  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
