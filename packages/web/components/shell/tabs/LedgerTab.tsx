"use client";

import { useMemo } from "react";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtCr, fmtEcon, num } from "../../../lib/format.ts";
import { UI, companyColor } from "../../../lib/palette.ts";
import { Badge, Panel, Stat, Table } from "../../ui/index.tsx";
import { LineChart } from "../../charts/CandleChart.tsx";

export function LedgerTab() {
  const { snap } = useWorld();
  const selectCompany = useUi((s) => s.selectCompany);
  const setTab = useUi((s) => s.setTab);
  const m = snap.money;
  const macro = useMemo(() => [
    { name: "CR supply", color: UI.cyan, points: snap.history.macro.map((p) => ({ t: p.t, v: p.crSupply / 100 })) },
    { name: "Households", color: UI.emerald, points: snap.history.macro.map((p) => ({ t: p.t, v: p.households / 100 })) },
    { name: "Treasury", color: UI.gold, points: snap.history.macro.map((p) => ({ t: p.t, v: p.treasuryCr / 100 })) },
  ], [snap.history.macro]);
  const players = useMemo(() => [...snap.players].sort((a, z) => z.netCr - a.netCr).slice(0, 12), [snap.players]);
  const companies = useMemo(() => [...snap.companies].sort((a, z) => z.valuation - a.valuation).slice(0, 12), [snap.companies]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <Panel title="Money" action={<Badge tone={m.conserved ? "up" : "down"}>{m.conserved ? "ledger conserved" : "conservation drift"}</Badge>}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="CR supply" value={fmtCr(m.crSupply)} size="sm" />
          <Stat label="Households" value={fmtCr(m.householdsCr)} size="sm" />
          <Stat label="Treasury CR" value={fmtCr(m.treasuryCr)} size="sm" tone="gold" />
          <Stat label="Dividends paid (cum.)" value={fmtCr(m.dividends)} size="sm" tone="up" />
          <Stat label="$ECON supply" value={fmtEcon(m.econSupply, { compact: true })} size="sm" />
          <Stat label="$ECON staked" value={fmtEcon(m.stakedEcon, { compact: true })} size="sm" tone="cyan" />
        </div>
      </Panel>

      <Panel title="Macro">
        {snap.history.macro.length > 1 ? <LineChart series={macro} height={160} /> : <div className="py-6 text-center text-[11px] text-muted">Series fill in as ticks pass.</div>}
        <div className="mt-1 flex gap-3 text-[10px] text-muted">
          {macro.map((s) => <span key={s.name}><span style={{ color: s.color }}>■</span> {s.name}</span>)}
        </div>
      </Panel>

      <Panel title="Companies by valuation" pad={false}>
        <Table
          dense
          rows={companies}
          rowKey={(c) => c.id}
          onRow={(c) => { selectCompany(c.id); if (c.public) setTab("exchange"); }}
          columns={[
            { key: "n", header: "Company", cell: (c) => <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: companyColor(c.id) }} />{c.name}{c.isPlayer && <Badge tone="cyan">P</Badge>}{c.bankrupt && <Badge tone="down">†</Badge>}</span> },
            { key: "v", header: "Valuation", align: "right", cell: (c) => fmtCr(c.valuation, { compact: true, unit: false }) },
            { key: "p", header: "Lifetime P&L", align: "right", cell: (c) => <span className={c.lifetimeProfit >= 0 ? "text-emerald-300" : "text-rose-300"}>{fmtCr(c.lifetimeProfit, { compact: true, unit: false, sign: true })}</span> },
            { key: "b", header: "Bldg", align: "right", cell: (c) => String(c.buildings) },
          ]}
        />
      </Panel>

      <Panel title="Players by net worth" pad={false}>
        <Table
          dense
          rows={players}
          rowKey={(p) => p.id}
          columns={[
            { key: "n", header: "Player", cell: (p) => p.name },
            { key: "co", header: "Company", cell: (p) => snap.companies.find((c) => c.id === p.companyId)?.name ?? "—" },
            { key: "net", header: "Net CR", align: "right", cell: (p) => fmtCr(p.netCr, { compact: true, unit: false }) },
            { key: "w", header: "$ECON", align: "right", cell: (p) => num(p.econ / 1_000_000, 1) },
          ]}
        />
      </Panel>
    </div>
  );
}
