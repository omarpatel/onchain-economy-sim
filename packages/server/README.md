# @econ-sim/server — authoritative tick server

Standalone Node process (not inside Next.js) that owns the one true `Game`
from `@econ-sim/sim`, advances it on a fixed interval, journals every mutation to
SQLite, streams each tick to browsers over WebSocket and emits per-epoch
$ECON allocations for the on-chain Merkle claim.

```
npm run server            # from the repo root (node packages/server/src/index.ts)
npm test -w @econ-sim/server # node --test test.ts
```

Requires Node ≥ 24 (`node:sqlite`, native `.ts` type stripping). No native deps.

## Environment

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `TICK_MS` | `1000` | wall-clock ms per sim tick |
| `DATA_DIR` | `./data` | `economy.sqlite` + `epochs/<n>.json` live here |
| `SEED` | `CONFIG.seed` | RNG seed for a fresh world (ignored on resume) |
| `NPCS` | `24` | NPC industrialists booted into a fresh world |
| `INVESTORS` | `8` | NPC investors booted into a fresh world |
| `WARMUP_TICKS` | `48` | ticks simulated before a fresh world opens |
| `ALLOW_GUEST` | `1` | `1` enables `POST /auth/guest` |
| `ADMIN_TOKEN` | unset | bearer token for `/admin/*` (disabled when unset) |
| `CORS_ORIGIN` | `http://localhost:3000` | value of `Access-Control-Allow-Origin` |
| `DOMAIN` | `localhost` | SIWS `domain` the signed message must carry |
| `AUTH_RATE_LIMIT` | `10` | `/auth/*` requests allowed per client IP per minute |

## Boot & persistence (`src/world.ts`, `src/persist.ts`)

* `DATA_DIR/economy.sqlite` (WAL, `synchronous=NORMAL`) holds: `snapshots(tick, json)`
  (last 3, full `Game.toJSON()`), `server_state(tick, json)` (oracle ring, on-chain
  stakes, last epoch price — paired with each snapshot), `intents(tick, seq, player_id, json)`
  (the journal), `players`, `sessions`, `epochs`, `results` (last 10 000), `meta(head)`.
* Every mutation made between ticks — queued intents, player joins/renames,
  admin oracle/fee/stake updates — is journaled with the head tick it was made at and
  committed atomically with that tick's results. A mutation is journaled only
  after the sim accepted it (a join refused with `JoinError` leaves no row).
* Boot: latest snapshot → `Game.fromJSON` → replay journal rows with
  `tick ≥ snapshot.tick` in `(tick, seq)` order, ticking up to the persisted head.
  A row the sim rejects during replay is logged and skipped. The sim is
  deterministic, so the resumed state is byte-identical to the uninterrupted run
  (covered by `test.ts`). No snapshot → `new Game(SEED)`,
  `boot({players: 0, npcs, investors})`, warm up, snapshot.
* A snapshot the engine refuses (`StateVersionError` after a `GameState.v` bump)
  is not fatal: `economy.sqlite` (+ `-wal`/`-shm`) is renamed to
  `economy.sqlite.bak-<timestamp>` and a fresh world boots (sessions/players are in
  the archived file).
* Snapshot every epoch (`tick % 24 === 0`), on `POST /admin/snapshot` and on
  SIGINT/SIGTERM (loop stopped, snapshot written, DB closed).
* Tick loop: `setInterval(TICK_MS)`, re-entrancy guarded; an overrunning tick is
  logged and the missed interval is skipped (no catch-up burst). One log line
  every 10 ticks (`tick, ms, clients, intents, events`) and one per epoch close.
* Player cap: `CONFIG.player.maxPlayers` (64). Beyond it, or when no HQ tile is
  free, joins fail with `503 { error: "world is full (max_players|map_full)" }`
  on `/api/me` and WS close `4013`.

## HTTP API (`src/http.ts`)

JSON everywhere; errors are `{ "error": string }` with a 4xx/5xx status.
`Authorization: Bearer <session token>` for player routes, `Bearer $ADMIN_TOKEN`
(compared in constant time) for admin. `/auth/*` is limited to `AUTH_RATE_LIMIT`
requests per client IP per minute (`429`).

| method | path | auth | response |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ ok, tick, players, uptime, lastTickMs, ticks, clients, tickMs }` |
| GET | `/api/economy` | – | `EconomySnapshot` of the last tick; strong `ETag: "t<tick>"`, `If-None-Match` → 304 |
| GET | `/api/me` | session | `PlayerView`; joins the player (founds their company) on first call; `503` when the world is full |
| GET | `/api/epochs/latest` | – | latest `EpochAllocation` (404 before the first epoch close) |
| GET | `/api/epochs/:n` | – | `EpochAllocation` for epoch `n` |
| GET | `/api/events?since=<tick>` | – | `{ tick, events: GameEvent[] }` — up to 500 most recent events with `tick ≥ since` |
| GET | `/auth/nonce` | – | `{ nonce }` single-use, 5-minute TTL; at most 10 000 live nonces (oldest evicted) |
| POST | `/auth/siws` | – | body `{ pubkey, message, signature }` → `{ token, playerId: "sol:<pubkey>", name }` |
| POST | `/auth/guest` | – | body `{ name? }` → `{ token, playerId: "guest:<uuid>", name }` (when `ALLOW_GUEST=1`) |
| POST | `/auth/name` | session | body `{ name }` → renames the player (control chars stripped, ≤ 32 chars, via `@econ-sim/sim/text`) |
| POST | `/admin/oracle` | admin | body `{ quotes: { SYM: usd }, econUsd? }` → `game.rwa.setQuotesUsd`; `econUsd` also enters the oracle ring |
| POST | `/admin/creator-fees` | admin | body `{ econMinorPerTick: number \| null }` → `game.chain.setExternalCreatorFees` |
| POST | `/admin/onchain-stakes` | admin | body `{ stakes: { "<base58 pubkey>": econMinor }, asOfSlot }` → replaces the on-chain staking positions used for `yield` rows; `409` when `asOfSlot` is older than the last accepted, ≤ 50 000 rows |
| POST | `/admin/snapshot` | admin | forces a snapshot, returns `{ ok, tick }` |

### SIWS (`src/auth.ts`)

1. `GET /auth/nonce`.
2. Wallet signs the standard Sign-In-With-Solana text (`buildSiwsMessage` renders it):
   ```
   <DOMAIN> wants you to sign in with your Solana account:
   <base58 pubkey>

   <statement>

   URI: ...
   Version: 1
   Chain ID: mainnet
   Nonce: <nonce>
   Issued At: <ISO-8601>
   ```
3. `POST /auth/siws { pubkey, message, signature }` — signature base58 or base64.
   Checks: domain = `DOMAIN`, address = `pubkey`, nonce known and unused,
   `Issued At` within ±10 min, optional `Expiration Time` not passed, ed25519
   signature valid (`node:crypto`). Player is upserted as `sol:<pubkey>` named
   `<first4>…<last4>` and a 30-day session token (32 random bytes, hex) is issued.

## WebSocket (`src/ws.ts`, path `/ws`, permessage-deflate)

```
client → { type: "auth", token }                    within 5 s of connecting, else close 4001
server → { type: "hello", playerId, tick, ticksPerDay, tickMs, snapshot, you }
server → { type: "tick", tick, snapshot, you, events, results }   every tick
client → { type: "intent", id, intent }             shape-checked; malformed → immediate
server → { type: "result", result: { id, ok: false, tick, error } }
                                                     valid → queued, applied at the start of
                                                     the next tick; its IntentResult arrives
                                                     in that tick's `results`
client → { type: "ping", t }  →  server → { type: "pong", t }
```

* Tick numbering: `tick` in a `tick` message (and in `events`/`results`) is the
  tick that was just simulated; `snapshot.tick` and `hello.tick` are the head
  (= that tick + 1, the next tick to simulate), matching `/api/economy`'s ETag.
* `hello.snapshot` is the last tick's public snapshot, so a player who has just
  joined appears in `snapshot.players` from the next `tick` message on.
* Close codes: `4001` auth timeout / first message not `auth`, `4003` invalid
  session, `4008` a third socket for the same player (max 2), `4013` world full.
* Rate limit: 20 intents/s per **player**, shared across their sockets (excess get
  an immediate `result` error). Results are routed by `(playerId, id)`, so two
  players reusing the same client id never receive each other's results.
* Shape checks: `kind` in the `Intent` union, required numbers finite (and > 0
  where the sim requires a positive amount), strings 1–64 chars, `side` ∈
  `bid|ask`, `mode` ∈ `auto|hold`. Semantics (funds, ownership, tile rules) are
  validated by the sim and reported through `results`.
* The public `snapshot` and `events` are serialized once per tick and shared;
  `you` (`PlayerView`) and `results` are serialized once per player and sent to
  each of that player's sockets.
* A handler exception (bad message, sim rejection) is logged and answered with
  `{ type: "error", message: "internal error" }`; it never reaches the event loop.
* Heartbeat ping every 30 s; sockets that miss a pong are terminated.

## Epoch allocations (`src/epochs.ts`)

On every `epoch_close` event the server writes `EpochAllocation`
(`epochs` table + `DATA_DIR/epochs/<n>.json`), consumed by
`@econ-sim/integration` to build the Merkle root (`leaf = keccak256(epoch ‖ index ‖ claimant ‖ amount)`).

In-sim `$ECON` (airdrops, sim staking, sim yield) is **soft** and never becomes
an on-chain liability. Real value comes only from this epoch's creator fees, and
only when they were observed by the worker (`epoch_close.feesExternal`;
simulated fees → every pool is 0):

* `dividend` rows: CR actually paid this epoch by **on-chain** companies to
  wallet-holding players (time-weighted by the sim's `dividend.paid`), converted
  at `PEG_USD_PER_CR = 0.01` and the epoch price, used **only as weights** over
  the pool `min(pegConvertedTotal, feesEcon × CONFIG.chain.dividendShareOfFees)`
  (0.3). Rows are scaled down proportionally to fit the pool (never up).
* `yield` rows: `feesEcon × CONFIG.chain.yieldFrac` (0.5) pro-rata to the
  on-chain staking positions last posted to `/admin/onchain-stakes`; sim
  `stakedEcon` earns nothing on-chain. Stakers who never signed in get
  `playerId: "sol:<pubkey>"`.
* `claimant` = the wallet pubkey; guests never get rows.
* Epoch price: median of the last 24 `econUsd` oracle updates, clamped to ±30%
  of the previous epoch's price (falls back to the sim price before the first
  external update). Ring, anchor and stakes live in `server_state` and the
  journal, so replay reproduces every allocation.
* The settlement worker additionally refuses epoch totals above
  `MAX_EPOCH_TOTAL_ECON` and above the funder balance.
