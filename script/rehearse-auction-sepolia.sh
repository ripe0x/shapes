#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

RPC_URL=${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
HOUSE=0x603C745cBFCC76ad47E1eCf6b875abC995959801
SCRIPT=script/SepoliaAuctionEvidence.s.sol:SepoliaAuctionEvidence

[[ $(git branch --show-current) == main ]] || {
  echo "Run only from main." >&2
  exit 1
}

git fetch origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || {
  echo "Local main must exactly match fetched origin/main." >&2
  exit 1
}
[[ -z $(git status --porcelain) ]] || {
  echo "Working tree must be clean." >&2
  exit 1
}

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
[[ $CHAIN_ID == 11155111 ]] || {
  echo "RPC is not Sepolia (chain id $CHAIN_ID)." >&2
  exit 1
}

for account in ripe0x feerecip; do
  cast wallet list | grep -q "^${account} " || {
    echo "Missing Foundry account: $account" >&2
    exit 1
  }
done

echo "Opening auction #0 and placing two bidder top-ups."
echo "Foundry will request the ripe0x and feerecip keystore passwords."
FOUNDRY_PROFILE=testnet forge script "$SCRIPT" \
  --sig "open()" \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  --account ripe0x \
  --account feerecip

AUCTION=$(cast call "$HOUSE" \
  "auctions(uint256)((address,address,uint256,uint64,uint64,uint64,uint32,uint16,uint64,uint64,address,bool,bool))" \
  0 --rpc-url "$RPC_URL" --json)
END_TIME=$(jq -r '.[0][3]' <<<"$AUCTION")
UNITS=$(jq -r '.[0][9]' <<<"$AUCTION")
WINNER=$(jq -r '.[0][10]' <<<"$AUCTION")

[[ $END_TIME =~ ^[0-9]+$ && $END_TIME -gt 0 ]] || {
  echo "Auction did not start." >&2
  exit 1
}
[[ $UNITS == 2 ]] || {
  echo "Expected two winning units, found $UNITS." >&2
  exit 1
}

echo "Auction live: winner $WINNER, 2 units, end time $END_TIME."
echo "Waiting for the live Sepolia deadline."
while true; do
  TIMESTAMP_HEX=$(cast block latest --rpc-url "$RPC_URL" --json | jq -r '.data.timestamp')
  TIMESTAMP=$((TIMESTAMP_HEX))
  (( TIMESTAMP >= END_TIME )) && break
  sleep 5
done

echo "Settling, delivering the lot, and releasing the winning cards."
echo "Foundry will request the ripe0x and feerecip keystore passwords again."
FOUNDRY_PROFILE=testnet forge script "$SCRIPT" \
  --sig "close()" \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  --account ripe0x \
  --account feerecip

cast call "$HOUSE" \
  "auctions(uint256)((address,address,uint256,uint64,uint64,uint64,uint32,uint16,uint64,uint64,address,bool,bool))" \
  0 --rpc-url "$RPC_URL" --json | jq .

echo "Sepolia auction evidence complete."
