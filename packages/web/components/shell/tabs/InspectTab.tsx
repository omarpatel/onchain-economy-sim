"use client";

import { Crosshair, Hammer } from "lucide-react";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtPct, fmtEcon } from "../../../lib/format.ts";
import { companyColor } from "../../../lib/palette.ts";
import { BUILDING_STYLE, RES_LABEL } from "../../three/world-style.ts";
import { Badge, Bar, Button, Panel, Stat } from "../../ui/index.tsx";
import { useIntent } from "../useIntent.ts";
import { BuildingRow, CompanyCard, NextSteps, Overview } from "./Overview.tsx";
import { ProductionCard, RecipeFlow } from "./Production.tsx";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge/60 py-1 text-xs last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right font-mono tabular-nums text-slate-100">{v}</span>
    </div>
  );
}

export function InspectTab() {
  const { snap, you } = useWorld();
  const selected = useUi((s) => s.selectedTile);
  const setBuildMenu = useUi((s) => s.setBuildMenu);
  const focusTile = useUi((s) => s.focusTile);
  const setTab = useUi((s) => s.setTab);
  const selectCompany = useUi((s) => s.selectCompany);
  const { submit, busy } = useIntent();

  const tile = selected ? snap.world.tiles.find((t) => t.id === selected) : undefined;
  if (!tile) return <Overview />;

  const b = tile.building;
  const owner = tile.owner ? snap.companies.find((c) => c.id === tile.owner) : undefined;
  const co = you?.company ?? null;
  const mine = !!co && tile.owner === co.id;
  const ownBuilding = b && co?.buildings.find((x) => x.id === b.id);

  return (
    <div className="flex flex-col gap-3 p-3">
      {ownBuilding && co && <ProductionCard tileId={tile.id} b={ownBuilding} co={co} snap={snap} />}

      <Panel
        title={`Tile (${tile.x}, ${tile.y})`}
        action={<Button size="sm" tone="ghost" onClick={() => focusTile(tile.x, tile.y)} title="Focus camera"><Crosshair size={12} /></Button>}
      >
        <div className="mb-2 flex flex-wrap gap-1">
          {tile.premium && <Badge tone="gold">premium · NFT land</Badge>}
          {tile.hq && <Badge tone="cyan">HQ</Badge>}
          {tile.res && <Badge>{RES_LABEL[tile.res]}</Badge>}
          {mine && <Badge tone="up">yours</Badge>}
        </div>
        <Row k="Resource" v={tile.res ? `${RES_LABEL[tile.res]} · richness ${tile.rich.toFixed(2)}` : "none (plain)"} />
        <Row k="Land price" v={tile.premium ? fmtEcon(tile.priceEcon) : fmtCr(tile.priceCr)} />
        <Row k="Owner" v={tile.ownerName ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: companyColor(tile.owner ?? "") }} />
            {tile.ownerName}
          </span>
        ) : "unclaimed"} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!tile.owner && co && (
            <Button size="sm" tone="primary" disabled={busy} onClick={() => submit({ kind: "buy_land", x: tile.x, y: tile.y }, `Bought tile (${tile.x},${tile.y})`, "place")}>
              Buy land · {tile.premium ? fmtEcon(tile.priceEcon) : fmtCr(tile.priceCr)}
            </Button>
          )}
          {!b && (mine || !tile.owner) && co && (
            <Button size="sm" onClick={() => setBuildMenu(true)} title="Open the build menu, pick a type, then click this tile"><Hammer size={12} /> Build here</Button>
          )}
        </div>
      </Panel>

      {b && !ownBuilding && (
        <Panel title="Building">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: BUILDING_STYLE[b.type].color }} />
              <span className="text-sm font-semibold text-slate-100">{BUILDING_STYLE[b.type].label}</span>
            </div>
            {b.live ? <Badge tone={b.utilization > 0 ? "up" : "down"}>{b.utilization > 0 ? "running" : "idle"}</Badge> : <Badge tone="gold">under construction</Badge>}
          </div>
          <RecipeFlow type={b.type} />
          <div className="mb-1 mt-3 flex items-center justify-between text-[11px]">
            <span className="text-muted">Utilization</span>
            <span className="font-mono tabular-nums">{fmtPct(b.utilization, 0, false)}</span>
          </div>
          <Bar value={b.utilization} tone={b.utilization > 0.5 ? "up" : b.utilization > 0 ? "gold" : "down"} />
        </Panel>
      )}

      {mine && co && (tile.hq || !b) && <CompanyCard co={co} snap={snap} />}

      {mine && co && tile.hq && (
        <Panel title={`Your buildings · ${co.buildings.length}`} action={<Button size="sm" tone="ghost" onClick={() => setBuildMenu(true)}><Hammer size={12} /> Build</Button>}>
          {co.buildings.length === 0
            ? <div className="text-[11px] text-muted">No buildings yet — open the build menu.</div>
            : <div className="-mx-1.5">{co.buildings.map((x) => <BuildingRow key={x.id} b={x} tick={snap.tick} />)}</div>}
        </Panel>
      )}
      {mine && co && tile.hq && <NextSteps co={co} snap={snap} />}

      {owner && !mine && (
        <Panel
          title="Owner company"
          action={<Button size="sm" tone="ghost" onClick={() => { selectCompany(owner.id); setTab("exchange"); }}>Exchange →</Button>}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-100">{owner.name}</span>
            <div className="flex gap-1">
              {owner.isPlayer && <Badge tone="cyan">player</Badge>}
              {owner.public && <Badge tone="gold">public</Badge>}
              {owner.onChain && <Badge tone="up">on-chain</Badge>}
              {owner.bankrupt && <Badge tone="down">bankrupt</Badge>}
              {owner.autopilot && <Badge>autopilot</Badge>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="Cash" value={fmtCr(owner.cash)} size="sm" />
            <Stat label="Debt" value={fmtCr(owner.debt)} size="sm" tone={owner.debt > 0 ? "down" : "default"} />
            <Stat label="Valuation" value={fmtCr(owner.valuation)} size="sm" />
            <Stat label="Market cap" value={owner.public ? fmtCr(owner.marketCap) : "—"} size="sm" />
            <Stat label="Buildings" value={`${owner.buildings} · ${owner.trucks} trucks`} size="sm" />
            <Stat label="Last tick net" value={fmtCr(owner.lastNet, { sign: true })} size="sm" tone={owner.lastNet >= 0 ? "up" : "down"} />
            <Stat label="Lifetime profit" value={fmtCr(owner.lifetimeProfit, { sign: true })} size="sm" tone={owner.lifetimeProfit >= 0 ? "up" : "down"} />
            <Stat label="Staked" value={fmtEcon(owner.stakedEcon)} size="sm" />
          </div>
        </Panel>
      )}
    </div>
  );
}
