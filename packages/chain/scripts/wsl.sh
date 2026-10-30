#!/usr/bin/env bash
# Economy Sim chain driver. Runs inside WSL (Ubuntu-24.04) where anchor/solana/cargo live.
#
#   bash scripts/wsl.sh keys           # generate/sync program keypairs -> declare_id!/Anchor.toml/programs.json
#   bash scripts/wsl.sh build          # anchor build (in ~/econ-sim-chain for speed), copy idl/types/.so back
#   bash scripts/wsl.sh test           # build if needed, then run LiteSVM tests with node --test
#   bash scripts/wsl.sh deploy-devnet  # anchor deploy --provider.cluster devnet
#   bash scripts/wsl.sh deploy-localnet  # anchor deploy against a local solana-test-validator (LOCALNET_RPC, default http://127.0.0.1:8899)
#
# Building on /mnt/c is 5-10x slower than on the ext4 home volume, so the package is
# mirrored to ~/econ-sim-chain (rsync, excluding node_modules/target) and artifacts are
# copied back: target/idl, target/types, target/deploy.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SRC/../.." && pwd)"
MIRROR="$HOME/econ-sim-chain"
CHAIN="$MIRROR/packages/chain"
NODE_VERSION="${ECON_NODE_VERSION:-22}"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use "$NODE_VERSION" >/dev/null
fi

sync_in() {
  mkdir -p "$CHAIN" "$MIRROR/packages/integration/src"
  rsync -a --delete \
    --exclude node_modules --exclude target --exclude .anchor --exclude test-ledger \
    "$SRC/" "$CHAIN/"
  # the dividends tests import the production Merkle helpers from the integration package
  rsync -a "$REPO/packages/integration/src/settlement.ts" "$MIRROR/packages/integration/src/settlement.ts"
  # keep program keypairs (deploy ids) in sync with the checked-in ones
  mkdir -p "$CHAIN/target/deploy"
  if ls "$SRC"/target/deploy/*-keypair.json >/dev/null 2>&1; then
    cp "$SRC"/target/deploy/*-keypair.json "$CHAIN/target/deploy/"
  fi
}

sync_out() {
  mkdir -p "$SRC/target/idl" "$SRC/target/types" "$SRC/target/deploy"
  cp "$CHAIN"/target/idl/*.json "$SRC/target/idl/"
  cp "$CHAIN"/target/types/*.ts "$SRC/target/types/"
  cp "$CHAIN"/target/deploy/*.so "$CHAIN"/target/deploy/*-keypair.json "$SRC/target/deploy/"
  cp "$CHAIN/Cargo.lock" "$SRC/Cargo.lock"
}

node_deps() {
  # One node_modules for the mirror root so both packages/chain/tests and
  # packages/integration/src resolve the same modules. Reinstall from scratch
  # when package.json changed or npm's optional-dependency bug dropped the
  # litesvm native binding (https://github.com/npm/cli/issues/4828).
  if ! cmp -s "$SRC/package.json" "$MIRROR/package.json" \
     || ! ls -d "$MIRROR"/node_modules/litesvm-* >/dev/null 2>&1; then
    cp "$SRC/package.json" "$MIRROR/package.json"
    (cd "$MIRROR" && rm -rf node_modules package-lock.json && npm install --no-audit --no-fund --loglevel=error)
  fi
}

cmd_keys() {
  mkdir -p "$SRC/target/deploy"
  local json="{" sep=""
  for p in dividends staking equity memecoin_factory; do
    kp="$SRC/target/deploy/$p-keypair.json"
    [ -f "$kp" ] || solana-keygen new --no-bip39-passphrase --silent -o "$kp"
    id="$(solana-keygen pubkey "$kp")"
    sed -i -E "s/^declare_id!\(\"[^\"]*\"\);/declare_id!(\"$id\");/" "$SRC/programs/$p/src/lib.rs"
    sed -i -E "s/^$p = \"[^\"]*\"/$p = \"$id\"/" "$SRC/Anchor.toml"
    json="$json$sep\n  \"$p\": \"$id\""
    sep=","
    echo "$p=$id"
  done
  printf "$json\n}\n" > "$SRC/programs.json"
  echo "wrote programs.json"
}

cmd_build() {
  sync_in
  (cd "$CHAIN" && anchor build)
  sync_out
}

cmd_test() {
  sync_in
  node_deps
  if ! ls "$CHAIN"/target/deploy/*.so >/dev/null 2>&1; then
    (cd "$CHAIN" && anchor build)
    sync_out
  fi
  (cd "$CHAIN" && node --test tests/*.test.ts)
}

cmd_deploy_devnet() {
  sync_in
  if ! ls "$CHAIN"/target/deploy/*.so >/dev/null 2>&1; then
    (cd "$CHAIN" && anchor build)
    sync_out
  fi
  # Four ~300 KB programs cost ~2.2 SOL each in rent (~9 SOL total). Devnet airdrops are
  # rate-limited (2 SOL per request, a few per day): `solana airdrop 2 --url devnet`.
  solana config set --url devnet >/dev/null
  echo "deployer: $(solana address)  balance: $(solana balance)"
  (cd "$CHAIN" && anchor deploy --provider.cluster devnet)
}

cmd_deploy_localnet() {
  sync_in
  if ! ls "$CHAIN"/target/deploy/*.so >/dev/null 2>&1; then
    (cd "$CHAIN" && anchor build)
    sync_out
  fi
  # Start the validator first (from ~/econ-sim-chain/packages/chain so the ledger stays off /mnt/c
  # and out of git). Agave ≥ 4 activates SIMD-0500 in genesis, which refuses the SBPF v0
  # binaries anchor 0.31 produces ("Detected sbpf_version required by the executable which are
  # not enabled"), so deactivate it:
  #   solana-test-validator --reset --ledger test-ledger \
  #     --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g
  local rpc="${LOCALNET_RPC:-http://127.0.0.1:8899}"
  solana config set --url "$rpc" >/dev/null
  solana airdrop 100 >/dev/null 2>&1 || true   # 4 programs ≈ 9 SOL rent; the local faucet is free
  echo "deployer: $(solana address)  balance: $(solana balance)  rpc: $rpc"
  (cd "$CHAIN" && anchor deploy --provider.cluster "$rpc")
  for p in dividends staking equity memecoin_factory; do
    echo "$p=$(solana-keygen pubkey "$CHAIN/target/deploy/$p-keypair.json")"
  done
}

case "${1:-}" in
  keys) cmd_keys ;;
  build) cmd_build ;;
  test) cmd_test ;;
  deploy-devnet) cmd_deploy_devnet ;;
  deploy-localnet) cmd_deploy_localnet ;;
  run) shift; sync_in; node_deps; (cd "$CHAIN" && "$@") ;;
  *) echo "usage: $0 {keys|build|test|deploy-devnet|deploy-localnet|run <cmd...>}" >&2; exit 2 ;;
esac
