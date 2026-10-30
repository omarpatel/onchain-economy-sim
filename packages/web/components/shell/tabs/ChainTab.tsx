"use client";

import { useMemo } from "react";
import { useWorld } from "../../../lib/world.ts";
import { useUi } from "../../../lib/store.ts";
import { fmtUsd, fmtEcon, num, shortId } from "../../../lib/format.ts";
import { companyColor } from "../../../lib/palette.ts";
import { Badge, Panel, Stat, Table } from "../../ui/index.tsx";
import { ClaimPanel } from "./ClaimPanel.tsx";

export function ChainTab() {
  const { snap } = useWorld();
  const selectTile = useUi((s) => s.selectTile);
  const focusTile = useUi((s) => s.focusTile);
  const m = snap.money;
  const staked = useMemo(() => [...snap.companies].filter((c) => c.stakedEcon > 0).sort((a, z) => z.stakedEcon - a.stakedEcon).slice(0, 8), [snap.companies]);
  const graduated = snap.companies.filter((c) => c.onChain);

  return (
    <div className="flex flex-col gap-3 p-3">
      <Panel title="$ECON" action={<Badge tone="cyan">{fmtUsd(snap.chain.econPriceUsd, 4)}</Badge>}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="Supply" value={fmtEcon(m.econSupply, { compact: true })} size="sm" />
          <Stat label="Circulating" value={fmtEcon(m.econCirculating, { compact: true })} size="sm" />
          <Stat label="Staked" value={fmtEcon(m.stakedEcon, { compact: true })} size="sm" tone="cyan" />
          <Stat label="Treasury" value={fmtEcon(m.treasuryEcon, { compact: true })} size="sm" tone="gold" />
          <Stat label="Creator fees (cum.)" value={fmtEcon(m.creatorFees, { compact: true })} size="sm" tone="gold" />
          <Stat label="Yield paid (cum.)" value={fmtEcon(m.yieldPaid, { compact: true })} size="sm" tone="up" />
          <Stat label="Burned (cum.)" value={fmtEcon(m.burned, { compact: true })} size="sm" tone="down" />
          <Stat label="Market cap" value={fmtUsd(snap.chain.econPriceUsd * m.econCirculating / 1_000_000, 0)} size="sm" />
        </div>
      </Panel>

      <ClaimPanel />

      <Panel title={`Land NFTs · ${snap.chain.landNfts.length}`} action={<Badge>settled per epoch</Badge>} pad={false}>
        <Table
          dense
          rows={snap.chain.landNfts}
          rowKey={(n) => n.id}
          onRow={(n) => { const t = snap.world.tiles.find((x) => x.id === n.tileId); if (t) { selectTile(t.id); focusTile(t.x, t.y); } }}
          empty="No premium land minted yet."
          columns={[
            { key: "id", header: "NFT", cell: (n) => n.id },
            { key: "tile", header: "Tile", cell: (n) => n.tileId },
            { key: "owner", header: "Owner", cell: (n) => <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: companyColor(n.owner) }} />{snap.companies.find((c) => c.id === n.owner)?.name ?? shortId(n.owner)}</span> },
            { key: "px", header: "Paid", align: "right", cell: (n) => fmtEcon(n.priceEcon) },
          ]}
        />
      </Panel>

      <Panel title="Staking leaderboard" action={<Badge>settled per epoch</Badge>} pad={false}>
        <Table
          dense
          rows={staked}
          rowKey={(c) => c.id}
          empty="Nobody has staked yet."
          columns={[
            { key: "co", header: "Company", cell: (c) => <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: companyColor(c.id) }} />{c.name}</span> },
            { key: "st", header: "Staked", align: "right", cell: (c) => fmtEcon(c.stakedEcon) },
            { key: "share", header: "Share", align: "right", cell: (c) => `${(m.stakedEcon > 0 ? (c.stakedEcon / m.stakedEcon) * 100 : 0).toFixed(1)}%` },
          ]}
        />
      </Panel>

      <Panel title={`Graduated on-chain · ${graduated.length}`} pad={false}>
        <Table
          dense
          rows={graduated}
          rowKey={(c) => c.id}
          empty="No company has crossed the graduation market cap."
          columns={[
            { key: "co", header: "Company", cell: (c) => c.name },
            { key: "cap", header: "Mkt cap", align: "right", cell: (c) => `${num(c.marketCap / 100)} CR` },
          ]}
        />
      </Panel>

      <Panel title="RWA oracle" action={<Badge>settled per epoch</Badge>} pad={false}>
        <Table dense rows={snap.chain.rwa} rowKey={(r) => r.symbol} columns={[
          { key: "s", header: "Symbol", cell: (r) => r.symbol },
          { key: "p", header: "USD", align: "right", cell: (r) => fmtUsd(r.usd) },
          { key: "w", header: "in $ECON", align: "right", cell: (r) => num(r.usd / Math.max(1e-9, snap.chain.econPriceUsd), 2) },
        ]} />
      </Panel>
    </div>
  );
}
