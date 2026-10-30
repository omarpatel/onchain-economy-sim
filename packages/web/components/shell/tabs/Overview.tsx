"use client";

import type { ReactNode } from "react";
import { ArrowRight, CircleCheck, Circle, Crosshair, Hammer, Link2, Package, Rocket, TrendingDown, TrendingUp, Truck, Wallet, CirclePause } from "lucide-react";
import { CONFIG } from "@econ-sim/sim/config";
import { ALL_BUILDINGS, ALL_GOODS, RECIPES, type BuildingType, type Good } from "@econ-sim/sim/goods";
import type { CompanyView } from "@econ-sim/sim/protocol";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { useSession } from "../../../lib/client/auth.ts";
import { useWalletSignIn } from "../../../lib/client/useWalletSignIn.ts";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, num, titleCase } from "../../../lib/format.ts";
import { companyColor } from "../../../lib/palette.ts";
import { BUILDING_STYLE } from "../../three/world-style.ts";
import { GoodIcon } from "../../ui/GoodIcon.tsx";
import { Badge, Bar, Button, Panel, Sparkline, Stat } from "../../ui/index.tsx";
import { useIntent } from "../useIntent.ts";
import { legs, type OwnBuilding } from "./Production.tsx";

/** Camera + selection jump used by every building row. */
function jumpTo(b: { x: number; y: number; tileId: string }) {
  const ui = useUi.getState();
  ui.focusTile(b.x, b.y);
  ui.selectTile(b.tileId);
}

/** Header card for the player's company: cash, last-tick P&L split, valuation, footprint and rank. */
export function CompanyCard({ co, snap }: { co: CompanyView; snap: EconomySnapshot }) {
  const setTab = useUi((s) => s.setTab);
  const focusTile = useUi((s) => s.focusTile);
  const hub = snap.world.tiles.find((t) => t.id === co.hubTileId);
  const p = co.lastPnl;
  const costs = p.inputCost + p.labor + p.energy + p.logistics + p.interest;
  const live = co.buildings.filter((b) => b.live).length;
  let rank = 1;
  for (const c of snap.companies) if (c.id !== co.id && c.valuation > co.valuationCr) rank++;
  return (
    <section className="glass rounded-lg p-3">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: companyColor(co.id) }} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-100">{co.name}</div>
            <div className="label">Your company · rank #{rank} of {snap.companies.length}</div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {co.isOnChain ? <Badge tone="up">on-chain</Badge> : co.isPublic ? <Badge tone="gold">public</Badge> : <Badge>private</Badge>}
          {co.autopilot && <Badge tone="cyan">autopilot</Badge>}
          {co.bankrupt && <Badge tone="down">bankrupt</Badge>}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-x-3">
        <Stat label="Cash" value={fmtCr(co.cashCr)} size="lg" />
        <Stat
          label="Last tick P&L"
          value={fmtCr(p.net, { sign: true })}
          size="lg"
          tone={p.net > 0 ? "up" : p.net < 0 ? "down" : "default"}
          sub={`${fmtCr(p.revenue, { compact: true })} rev · ${fmtCr(costs, { compact: true })} costs`}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-edge pt-2">
        <Stat label="Valuation" value={fmtCr(co.valuationCr, { compact: true })} size="sm" />
        <Stat label="Buildings" value={`${live}${live < co.buildings.length ? ` +${co.buildings.length - live}` : ""}`} size="sm" sub={live < co.buildings.length ? "live + building" : `of ${CONFIG.company.maxBuildings} max`} />
        <Stat label="Trucks" value={String(co.trucks)} size="sm" sub={`${num(co.haulDemand)}/${num(co.truckCapacity)} w/t`} />
      </div>
      <div className="mt-2 flex gap-1.5">
        {hub && <Button size="sm" onClick={() => focusTile(hub.x, hub.y)}><Crosshair size={12} /> HQ</Button>}
        <Button size="sm" tone="ghost" onClick={() => setTab("company")}>Company <ArrowRight size={12} /></Button>
      </div>
    </section>
  );
}

/** One owned building: dot, name, coordinates, utilization and a focus jump. */
export function BuildingRow({ b, tick }: { b: OwnBuilding; tick: number }) {
  const style = BUILDING_STYLE[b.type];
  return (
    <button onClick={() => jumpTo(b)} className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-white/[0.05]">
      <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: style.color }} />
      <span className="flex-1 truncate text-slate-100">{style.label} <span className="font-mono text-muted">({b.x},{b.y})</span></span>
      {b.live
        ? <span className="flex w-24 items-center gap-1.5"><Bar value={b.utilization} tone={b.utilization > 0.5 ? "up" : b.utilization > 0 ? "gold" : "down"} /><span className="w-8 text-right font-mono tabular-nums text-muted">{fmtPct(b.utilization, 0, false)}</span></span>
        : <span className="w-24 text-right font-mono text-[10px] text-amber-300">live in {Math.max(0, b.liveAtTick - tick)}t</span>}
      <Crosshair size={12} className="shrink-0 text-muted group-hover:text-mint-300" />
    </button>
  );
}

const isProcessor = (t: BuildingType) => legs(RECIPES[t].inputs).length > 0;

/**
 * Downstream plant that uses the most of what the company already extracts
 * (ties → cheaper). Null when nothing it makes feeds any processor.
 */
function suggestProcessor(co: CompanyView): { type: BuildingType; feeds: Good[] } | null {
  const made = new Set<Good>();
  for (const b of co.buildings) for (const [g] of legs(RECIPES[b.type].outputs)) made.add(g);
  let best: { type: BuildingType; feeds: Good[] } | null = null;
  for (const t of ALL_BUILDINGS) {
    if (!isProcessor(t)) continue;
    const feeds = legs(RECIPES[t].inputs).map(([g]) => g).filter((g) => made.has(g));
    if (feeds.length === 0) continue;
    if (!best || feeds.length > best.feeds.length || (feeds.length === best.feeds.length && RECIPES[t].buildCostCr < RECIPES[best.type].buildCostCr)) best = { type: t, feeds };
  }
  return best;
}

function Step({ done, icon, title, children, action }: { done?: boolean; icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <li className={`flex gap-2.5 border-b border-edge/60 py-2 last:border-0 ${done ? "opacity-55" : ""}`}>
      <span className={`mt-px shrink-0 ${done ? "text-mint-300" : "text-slate-300"}`}>{done ? <CircleCheck size={15} /> : icon}</span>
      <div className="min-w-0 flex-1">
        <div className={`text-xs font-semibold ${done ? "text-muted line-through decoration-white/20" : "text-slate-100"}`}>{title}</div>
        {children && <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </li>
  );
}

/** Mounted only when the wallet step is open so the adapter hook runs only then. */
function WalletStep() {
  const wallet = useWalletSignIn();
  return (
    <Step
      icon={<Wallet size={15} />}
      title="Connect a wallet for dividends"
      action={<Button size="sm" disabled={wallet.busy} onClick={() => void wallet.signIn()}>{wallet.busy ? "Signing…" : "Connect"}</Button>}
    >
      Once your company graduates on-chain, epoch dividends settle to $ECON on Solana and are claimed in the Chain tab with a signed-in wallet.
    </Step>
  );
}

/**
 * Checklist derived from live company state: problems needing a click first
 * (idle plants, held stock, saturated fleet), then the growth milestones.
 */
export function NextSteps({ co, snap }: { co: CompanyView; snap: EconomySnapshot }) {
  const session = useSession((s) => s.session);
  const { submit, busy } = useIntent();
  const ui = useUi.getState;

  const idle = co.buildings.filter((b) => b.live && b.utilization === 0);
  const building = co.buildings.filter((b) => !b.live);
  const held = ALL_GOODS.filter((g) => co.sellPolicy[g] === "hold" && co.inventory[g] > 0);
  const fleetFull = co.haulDemand > co.truckCapacity;
  const hasExtractor = co.buildings.some((b) => !isProcessor(b.type));
  const hasProcessor = co.buildings.some((b) => isProcessor(b.type));
  const suggestion = hasProcessor ? null : suggestProcessor(co);
  const profitable = co.lastPnl.net > 0;
  const g = co.graduationProgress;
  const x = CONFIG.chain;
  const wallet = session?.kind === "wallet";

  const milestones = [hasExtractor, hasProcessor, co.isPublic, co.isOnChain, wallet];
  const doneCount = milestones.filter(Boolean).length;

  return (
    <Panel title="Next steps" action={<span className="font-mono text-[10px] tabular-nums text-muted">{doneCount}/{milestones.length}</span>}>
      <Bar value={doneCount / milestones.length} tone="up" className="mb-1" />
      <ul>
        {idle.length > 0 && (
          <Step icon={<CirclePause size={15} className="text-rose-400" />} title={`${idle.length} idle building${idle.length > 1 ? "s" : ""}`}>
            Made nothing last tick. Open one to see why.
            <div className="mt-1 -mx-1.5">{idle.map((b) => <BuildingRow key={b.id} b={b} tick={snap.tick} />)}</div>
          </Step>
        )}
        {held.map((good) => (
          <Step
            key={good}
            icon={<Package size={15} className="text-amber-300" />}
            title={`${num(co.inventory[good])} ${titleCase(good)} held in stock`}
            action={<Button size="sm" onClick={() => { ui().selectGood(good); ui().setTab("market"); }}>Market <ArrowRight size={12} /></Button>}
          >
            Sell policy is hold; plants idle once stock passes {CONFIG.company.maxStockTicks} ticks of output.
          </Step>
        ))}
        {fleetFull && (
          <Step
            icon={<Truck size={15} className="text-amber-300" />}
            title="Fleet is the bottleneck"
            action={<Button size="sm" disabled={busy} onClick={() => submit({ kind: "buy_truck" }, "Truck added to the fleet", "place")}>Buy truck</Button>}
          >
            Plants need {num(co.haulDemand)} w/t hauled; {co.trucks} truck{co.trucks === 1 ? "" : "s"} carry {num(co.truckCapacity)}. Output is throttled to match.
          </Step>
        )}
        {building.length > 0 && (
          <Step icon={<Hammer size={15} className="text-amber-300" />} title={`${building.length} under construction`}>
            <div className="-mx-1.5">{building.map((b) => <BuildingRow key={b.id} b={b} tick={snap.tick} />)}</div>
          </Step>
        )}

        <Step done={hasExtractor} icon={<Circle size={15} />} title="Extract a raw resource"
          action={!hasExtractor && <Button size="sm" tone="primary" onClick={() => ui().setBuildMenu(true)}><Hammer size={12} /> Build</Button>}>
          {!hasExtractor && "Mines, wells, farms and forestry sit on matching deposits; the Richness layer shows the best tiles."}
        </Step>
        <Step done={hasProcessor} icon={<Circle size={15} />}
          title={suggestion ? `Build a ${BUILDING_STYLE[suggestion.type].label} next to your HQ` : "Build a processor next to your HQ"}
          action={!hasProcessor && <Button size="sm" tone="primary" onClick={() => ui().setBuildMenu(true)}><Hammer size={12} /> Build</Button>}>
          {!hasProcessor && (suggestion
            ? <>Turns your {suggestion.feeds.map(titleCase).join(" + ")} into {legs(RECIPES[suggestion.type].outputs).map(([o]) => titleCase(o)).join(", ")} worth more per unit; missing inputs are bought on the market. Costs {fmtCr(RECIPES[suggestion.type].buildCostCr, { digits: 0 })}.</>
            : "Factories turn raw goods into higher-value goods. Close to the HQ keeps haul costs low.")}
        </Step>
        <Step done={co.isPublic} icon={<Rocket size={15} />} title={profitable || co.isPublic ? "Go public" : "Turn a profit, then go public"}
          action={!co.isPublic && profitable && <Button size="sm" tone="primary" onClick={() => ui().setTab("company")}>IPO <ArrowRight size={12} /></Button>}>
          {!co.isPublic && (profitable
            ? `You made ${fmtCr(co.lastPnl.net, { sign: true })} last tick. List shares to raise CR from investors.`
            : `Last tick ${fmtCr(co.lastPnl.net, { sign: true })}. Investors buy into companies that earn.`)}
        </Step>
        {co.isPublic && (
          <Step done={co.isOnChain} icon={<Link2 size={15} />} title="Graduate on-chain">
            {!co.isOnChain && `Epochs public ${g.epochsPublic}/${x.graduateMinEpochs} · VWAP cap ${fmtCr(g.vwapCapCr, { compact: true })}/${fmtCr(x.graduateMarketCapCr, { compact: true })} · volume ${fmtPct(g.volumePctFloat, 1, false)}/${fmtPct(x.graduateMinVolumeOfFloat, 0, false)} of float`}
          </Step>
        )}
        {wallet ? <Step done icon={<Wallet size={15} />} title="Wallet connected for dividends" /> : <WalletStep />}
      </ul>
    </Panel>
  );
}

/** Top three 24-tick gainers and losers; a row opens that good in the Market tab. */
export function MarketMovers({ snap }: { snap: EconomySnapshot }) {
  const selectGood = useUi((s) => s.selectGood);
  const setTab = useUi((s) => s.setTab);
  const sorted = [...snap.goods].sort((a, z) => z.change24 - a.change24);
  const up = sorted.filter((g) => g.change24 > 0).slice(0, 3);
  const down = sorted.filter((g) => g.change24 < 0).reverse().slice(0, 3);
  const row = (g: EconomySnapshot["goods"][number]) => (
    <button key={g.good} onClick={() => { selectGood(g.good); setTab("market"); }} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.05]">
      <GoodIcon good={g.good} size={24} />
      <span className="flex-1 truncate text-xs text-slate-100">{titleCase(g.good)}</span>
      <Sparkline values={snap.history.goods[g.good].slice(-24).map((c) => c.c)} width={56} height={18} tone={g.change24 >= 0 ? "up" : "down"} />
      <span className="w-16 text-right font-mono text-[11px] tabular-nums text-slate-100">{fmtCr(g.price)}</span>
      <span className={`w-14 text-right font-mono text-[11px] tabular-nums ${g.change24 >= 0 ? "text-mint-300" : "text-rose-400"}`}>{fmtPct(g.change24)}</span>
    </button>
  );
  return (
    <Panel title="Market movers · 24 ticks" action={<Button size="sm" tone="ghost" onClick={() => setTab("market")}>Market <ArrowRight size={12} /></Button>}>
      {up.length === 0 && down.length === 0 && <div className="text-[11px] text-muted">Prices are flat across all goods.</div>}
      {up.length > 0 && (
        <>
          <div className="label mb-0.5 flex items-center gap-1"><TrendingUp size={11} className="text-mint-300" /> Gainers</div>
          {up.map(row)}
        </>
      )}
      {down.length > 0 && (
        <>
          <div className="label mb-0.5 mt-2 flex items-center gap-1"><TrendingDown size={11} className="text-rose-400" /> Losers</div>
          {down.map(row)}
        </>
      )}
    </Panel>
  );
}

/** Inspect tab with nothing selected: your company, what to do next, and where prices are moving. */
export function Overview() {
  const { snap, you } = useWorld();
  const co = you?.company ?? null;
  return (
    <div className="flex flex-col gap-3 p-3">
      {co ? (
        <>
          <CompanyCard co={co} snap={snap} />
          <NextSteps co={co} snap={snap} />
        </>
      ) : (
        <Panel title={you ? "No company" : "Spectating"}>
          <p className="text-xs text-slate-300">{you ? "This player has no company yet." : "Sign in to found a company with starter capital, an HQ and a first extractor."}</p>
        </Panel>
      )}
      <MarketMovers snap={snap} />
      <p className="px-1 text-[11px] leading-relaxed text-muted">
        Click any tile or building to inspect it · left-drag pans · right-drag orbits · wheel zooms · WASD pans · <span className="text-slate-300">B</span> opens the build menu.
      </p>
    </div>
  );
}
