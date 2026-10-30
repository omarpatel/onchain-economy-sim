import { Connection } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { DividendsClient, loadDividendsIdl } from "./dividends.ts";
import { startProofServer } from "./http.ts";
import { RollingMedian } from "./median.ts";
import { bondingCurveCreator, feeInflowEconMinorPerTick, PumpFunFees } from "./pumpfun.ts";
import { jupiterUsdPrice, RwaFeed } from "./rwa.ts";
import { GameServer } from "./server.ts";
import { EpochSettler, SettlementStore } from "./settle.ts";
import { loadStakingIdl, StakeObserver } from "./stakes.ts";

/**
 * Settlement worker. Runs alongside the authoritative game server and bridges
 * the off-chain economy to Solana every `POLL_MS`:
 *   1. epoch dividends → Merkle root → `dividends.set_epoch_root` (+ proofs API),
 *   2. on-chain staking positions → `POST /admin/onchain-stakes`,
 *   3. RWA marks (Pyth / Jupiter) + median $ECON/USD → `POST /admin/oracle`,
 *   4. pump.fun creator fees → sweep + `POST /admin/creator-fees`.
 * Every step is independent and retried on the next poll; nothing here throws
 * past the loop except a config error at startup.
 */

/** Default claim window for `init_distributor` (7 days). */
const CLAIM_WINDOW_SECS = BigInt(process.env.CLAIM_WINDOW_SECS ?? 7 * 24 * 3600);
/** $ECON/USD polls kept for the rolling median (12 × POLL_MS = 6 min at the default interval). */
const ECON_PRICE_WINDOW = 12;

class Worker {
  private readonly cfg: Config;
  private readonly conn: Connection;
  private readonly server: GameServer;
  readonly store: SettlementStore;
  private readonly rwa: RwaFeed;
  private dividends: DividendsClient | null = null;
  private settler: EpochSettler | null = null;
  private distributorChecked = false;
  private stakes: StakeObserver | null = null;
  private lastStakeDigest = "";
  private readonly econUsd = new RollingMedian(ECON_PRICE_WINDOW);
  private fees: PumpFunFees | null = null;
  private feeBaseline: { lamports: number; tick: number } | null = null;
  private econDecimals: number | null = null;
  private lastError: Record<string, string> = {};

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.server = new GameServer(cfg.serverUrl, cfg.adminToken);
    this.store = new SettlementStore(cfg.dataDir);
    this.rwa = new RwaFeed({ hermesUrl: cfg.hermesUrl, apiKey: cfg.pythApiKey, jupUrl: cfg.jupPriceUrl });
  }

  status(): Record<string, unknown> {
    return {
      dryRun: this.cfg.dryRun,
      rpc: this.cfg.rpcUrl,
      server: this.cfg.serverUrl,
      maxEpochTotalEcon: this.cfg.maxEpochTotalEcon,
      blocked: this.store.blocked(),
      econUsd: this.econUsd.value,
      errors: this.lastError,
    };
  }

  /** Log an error once per distinct message per step, so a down server doesn't spam. */
  private fail(step: string, e: unknown): void {
    const msg = (e as Error).message ?? String(e);
    if (this.lastError[step] !== msg) console.warn(`[${step}] ${msg} (will retry in ${this.cfg.pollMs / 1000}s)`);
    this.lastError[step] = msg;
  }
  private ok(step: string): void {
    if (this.lastError[step]) console.log(`[${step}] recovered`);
    delete this.lastError[step];
  }

  async tick(): Promise<void> {
    await this.settle();
    await this.observeStakes();
    const solUsd = await this.oracle();
    await this.creatorFees(solUsd);
  }

  private async settle(): Promise<void> {
    try {
      if (!this.dividends) {
        this.dividends = new DividendsClient({
          conn: this.conn,
          authority: this.cfg.authority,
          mint: this.cfg.econMint,
          programId: this.cfg.programs.dividends,
          idl: loadDividendsIdl(),
          dryRun: this.cfg.dryRun,
        });
        this.settler = new EpochSettler(this.server, this.dividends, this.store, { maxEpochTotalEcon: this.cfg.maxEpochTotalEcon });
        console.log(`[dividends] program=${this.dividends.programId.toBase58()} distributor=${this.dividends.distributor.toBase58()}`);
      }
      // Live: initialise once and re-check until it exists. Dry-run: simulate the init exactly once.
      if (!this.distributorChecked) {
        const init = await this.dividends.ensureDistributor(CLAIM_WINDOW_SECS);
        if (init === null) console.log("[dividends] distributor already initialised");
        this.distributorChecked = this.cfg.dryRun || init === null || init.signature !== null;
      }
      const results = await this.settler!.run();
      for (const r of results) {
        if (r.status === "published") {
          const o = r.outcome!;
          console.log(`[settle] epoch ${r.epoch} → ${o.dryRun ? "dry-run" : o.signature} proofs=${r.proofsPath}`);
          if (o.simulationError) console.log(`[settle]   simulation: ${o.simulationError}\n  ${o.logs.slice(-6).join("\n  ")}`);
          this.ok(`settle:${r.epoch}`);
        } else if (r.status === "blocked") {
          this.fail(`settle:${r.epoch}`, new Error(r.reason));
        } else {
          console.log(`[settle] epoch ${r.epoch} skipped (${r.status})`);
        }
      }
      this.ok("settle");
    } catch (e) {
      this.fail("settle", e);
    }
  }

  /** Report every on-chain staking position so yield rows are pro-rata to locked $ECON, not sim balances. */
  private async observeStakes(): Promise<void> {
    try {
      if (!this.stakes) {
        this.stakes = new StakeObserver({
          conn: this.conn,
          programId: this.cfg.programs.staking,
          econMint: this.cfg.econMint,
          idl: loadStakingIdl(),
        });
        console.log(`[stakes] program=${this.stakes.programId.toBase58()} pool=${this.stakes.pool.toBase58()}`);
      }
      const snap = await this.stakes.snapshot();
      await this.server.postOnchainStakes(snap.stakes, snap.asOfSlot);
      const digest = JSON.stringify(snap.stakes);
      if (digest !== this.lastStakeDigest) {
        let total = 0;
        for (const amount of Object.values(snap.stakes)) total += amount;
        console.log(`[stakes] ${Object.keys(snap.stakes).length} stakers / ${snap.positions} positions, total=${total} minor @ slot ${snap.asOfSlot}`);
        this.lastStakeDigest = digest;
      }
      this.ok("stakes");
    } catch (e) {
      this.fail("stakes", e);
    }
  }

  /**
   * Push RWA marks (+ $ECON/USD when PUMP_MINT is known). The $ECON price sent
   * is the rolling median of the last `ECON_PRICE_WINDOW` Jupiter reads, so a
   * momentary on-chain dump before an epoch close cannot inflate allocations;
   * the server medians its own 24-update ring and clamps per-epoch moves on top.
   * Returns SOL/USD for the fee formula.
   */
  private async oracle(): Promise<number | null> {
    let solUsd: number | null = null;
    try {
      const quotes = await this.rwa.refresh();
      const byMint: Record<string, number> = {};
      for (const q of quotes) {
        if (q.symbol === "SOL") solUsd = q.priceUsd;
        else byMint[q.symbol] = q.priceUsd;
      }
      const spot = this.cfg.pumpMint ? await jupiterUsdPrice(this.cfg.jupPriceUrl, this.cfg.pumpMint.toBase58()) : null;
      const econ = spot ? this.econUsd.push(spot.usd) : null;
      console.log(
        `[rwa] ${quotes[0]?.source} ${quotes.map((q) => `${q.symbol}=${q.priceUsd.toFixed(2)}`).join(" ")}${spot ? ` ECON=$${spot.usd} median(${this.econUsd.size})=$${econ}` : ""}`,
      );
      await this.server.postOracle(byMint, econ ?? undefined);
      this.ok("oracle");
    } catch (e) {
      this.fail("oracle", e);
    }
    return solUsd;
  }

  private async creatorFees(solUsd: number | null): Promise<void> {
    try {
      if (!this.fees) {
        const creator =
          this.cfg.pumpCreator ??
          (this.cfg.pumpMint ? await bondingCurveCreator(this.conn, this.cfg.pumpMint) : null) ??
          this.cfg.authority.publicKey;
        this.fees = new PumpFunFees({ conn: this.conn, creator, minSweepLamports: this.cfg.minSweepLamports, dryRun: this.cfg.dryRun });
        console.log(`[pumpfun] creator=${creator.toBase58()} vault=${this.fees.vault.toBase58()}`);
      }
      const lamports = await this.fees.vaultLamports();
      const { tick } = await this.server.health();

      if (this.feeBaseline) {
        const delta = lamports - this.feeBaseline.lamports;
        const ticksElapsed = tick - this.feeBaseline.tick;
        if (delta > 0 && ticksElapsed > 0) {
          const econMint = this.cfg.pumpMint ?? this.cfg.econMint;
          const econ = await jupiterUsdPrice(this.cfg.jupPriceUrl, econMint.toBase58());
          this.econDecimals ??= econ?.decimals ?? (await getMint(this.conn, econMint)).decimals;
          // Same manipulation-resistant price as the oracle step when PUMP_MINT is set; spot otherwise.
          const econUsd = this.cfg.pumpMint ? this.econUsd.value : (econ?.usd ?? null);
          if (solUsd && econUsd) {
            const perTick = feeInflowEconMinorPerTick({
              lamports: delta,
              solUsd,
              econUsd,
              econDecimals: this.econDecimals,
              ticksElapsed,
            });
            await this.server.postCreatorFees(perTick);
            console.log(`[pumpfun] +${delta} lamports over ${ticksElapsed} ticks → ${perTick} $ECON minor/tick`);
          } else {
            console.warn(`[pumpfun] +${delta} lamports but no ${solUsd ? "$ECON" : "SOL"}/USD price; skipped report`);
          }
        }
      } else {
        console.log(`[pumpfun] vault=${lamports} lamports at tick ${tick}`);
      }
      this.feeBaseline = { lamports, tick };

      const swept = await this.fees.sweep(this.cfg.authority);
      if (swept && swept !== "dry-run") this.feeBaseline = { lamports: await this.fees.vaultLamports(), tick };
      this.ok("pumpfun");
    } catch (e) {
      this.fail("pumpfun", e);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(
    `[worker] ${cfg.dryRun ? "DRY_RUN" : "LIVE"} rpc=${cfg.rpcUrl} server=${cfg.serverUrl} authority=${cfg.authority.publicKey.toBase58()} mint=${cfg.econMint.toBase58()} data=${cfg.dataDir}`,
  );
  const worker = new Worker(cfg);
  const http = startProofServer(worker.store, cfg.port, () => worker.status());

  let running = false;
  const loop = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } finally {
      running = false;
    }
  };
  await loop();
  const timer = setInterval(loop, cfg.pollMs);

  const stop = (): void => {
    clearInterval(timer);
    http.close();
    console.log("[worker] stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  if (e instanceof ConfigError) console.error(`[config] ${e.message}`);
  else console.error(e);
  process.exit(1);
});
