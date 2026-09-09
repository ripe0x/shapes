# Audit brief: ShapeAuctionHouse scheduled start and house replacement (local AI audit)

You are an independent smart-contract security auditor running locally against a checked-out
repository. This is a delta audit. The core token (`Shapes`, its libraries, `ShapeCollection`,
`ShapeRenderer`) is live on Ethereum mainnet and was audited in the v8 and v9 rounds. This round
audits one changed contract, `ShapeAuctionHouse`, and the procedure that replaces the live house
with it. Report findings. Do not change files under `src/`. Put any proof-of-concept tests under
`test/audit/` only.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
branch      main
commit      debb78c
phase       mainnet live; core token deployed; auction house being replaced
```

Check out that commit before reading anything. Everything you cite must carry `path:line` from
this commit.

Live mainnet state at the time of this brief:

```text
Shapes             0x6fe9193276bf7abcbee44ab7afd717d637d6faf0
old house          0x90b79dbf4f301c239983ee37e6a466132e1532df  (Shapes.market() points here, unlocked)
deployer / admin   0xCB43078C32423F5348Cab5885911C3B5faE217F9  (EIP-7702 delegated EOA)
token #0           held by the deployer; old house auction 0 is settled and lotClaimed
new house          not yet deployed; address will be recorded in deployments/1.json
```

## How to run

```bash
forge build --sizes
forge test
forge test --match-path 'test/Auction*' -vv
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract Fork -vv
anvil --port 8560 --gas-limit 5000000000 &  # then: RPC_URL=http://127.0.0.1:8560 script/deploy.sh anvil
DRY_RUN=1 LIST_OWNER_TOKEN=1 AUCTION_START_TIME=<now + 300> script/deploy.sh mainnet   # simulates the real existing-token deploy, broadcasts nothing
```

Expected at this commit: 690 Foundry tests pass and 5 are skipped (fork tests, skipped
without `MAINNET_RPC_URL`). `ShapeAuctionHouse` measures 10,397 runtime bytes. Treat these as
evidence, never as a substitute for your own reasoning.

## What changed since v9

Read the diff between the v9 commit `34d2c3b` and the fixed target for these paths only; the rest
of `src/` is unchanged and deployed.

```text
src/ShapeAuctionHouse.sol
src/interfaces/IShapeAuctionHouse.sol
src/interfaces/IShapeAuctionHouseStartTime.sol
script/Deploy.s.sol
script/deploy.sh
test/AuctionStart.t.sol
```

The changes:

1. `Auction.startTime` (uint64). `bid` reverts `NotStarted` while `block.timestamp < startTime`.
   The end clock still starts at the first bid, never at `startTime`.
2. A second `createAuction` overload with a `startTime` parameter, declared in the extension
   interface `IShapeAuctionHouseStartTime`. The original overload sets `startTime` to zero. The
   house reports both interfaces through ERC-165. `Shapes.setPointer` requires only the base
   `IShapeAuctionHouse` id, which must be unchanged from the deployed house.
3. `setStartTime(auctionId, startTime)`: seller only, only while `highestBidder == address(0)` and
   the auction is not settled. Zero or a past time opens bidding now. Emits
   `AuctionStartTimeChanged`.
4. `MAX_START_LEAD = 365 days` bounds `startTime` in both `createAuction` and `setStartTime`
   (`StartTooFar`). `MAX_DURATION = 30 days` bounds `duration` only.
5. `script/deploy.sh` existing-token mode: with `SHAPES_ADDRESS` set, the deploy script deploys only
   a new house against the live token, calls `Shapes.setPointer` to move `market()` to it, and with
   `LIST_OWNER_TOKEN=1` lists token #0 from the deployer with `AUCTION_START_TIME`.

The operator's intent: list token #0 on the new house with a start about one year out, share the
listing, and later call `setStartTime` once to open bidding at a chosen time. The site hides the
scheduled date behind a build flag; assume the date is public on chain.

## System model

`ShapeAuctionHouse` is an independent contract. It holds no authority over `Shapes`. It escrows an
ERC-721 lot and takes bids priced in Shapes cards through `ShapeCardEscrow`, which mints cards
against ETH sent with a bid and holds cards a bidder transfers in. The seller receives the cards
of the winning bid. Losing bidders withdraw their cards. The seller can cancel while no bid exists
and reclaim the lot with `claimLot`. One auction per (nft, tokenId) at a time; the mapping entry is
cleared on `claimLot`.

Token #0 is the owner token of the collection. Escrowing it moves `Shapes.owner()` to the house for
the auction's life. `Shapes.market()` is an optional discovery pointer to the house; it grants the
house nothing.

Read `src/ShapeAuctionHouse.sol`, `src/ShapeCardEscrow.sol`, both house interfaces,
`script/Deploy.s.sol`, `script/deploy.sh`, then `test/AuctionStart.t.sol`, `test/AuctionHouse.t.sol`
and `test/AuctionSecurity.t.sol`. Read `src/Shapes.sol` only for `setPointer`, `lockPointer`,
`market()`, `mintStart` and the ERC-721 receiver path.

## Trust model to verify, not assume

1. Every state write in the house is reachable only by the actor the interface names: seller for
   `cancelAuction`, `setStartTime`, `claimProceeds`; bidder for `bid`, `withdraw`; lot recipient for
   `claimLot`; anyone for `settle` after the end. Build the table (function, check, state written)
   and find any path where a check is missing or runs after a write.
2. `setStartTime` cannot be reached once a bid exists, once settled, or once cancelled. Confirm
   with the exact guard expression and with the ordering of `bid`'s writes: a bid that lands in the
   same block as a `setStartTime` must leave the auction in exactly one of the two states.
3. The base interface id `type(IShapeAuctionHouse).interfaceId` equals the value the deployed house
   at `0x90b7…32df` reports. Compute it from the interface, compare against the literal the tests
   assert, and confirm `Shapes.setPointer`'s ERC-165 gate still passes for the new house.
4. The new house has no path to receive authority over `Shapes`, no owner, no upgrade hook, no
   selfdestruct, and no way for the deployer to touch a bidder's escrowed cards or ETH.

## Properties to falsify

Scheduling

- No path opens bidding before `startTime` while `startTime > block.timestamp`. Check `bid`, and
  any function that could set `highestBidder` or `endTime` without going through `bid`.
- `setStartTime` after the first bid is impossible. Try: bid, withdraw the bid, then
  `setStartTime`. Try: a bid that reverts partway. Try: reentrancy from a card transfer or ERC-721
  receiver into `setStartTime`.
- `setStartTime` cannot revive a settled or cancelled auction, and cannot be called on an auction id
  that does not exist.
- `startTime` values: zero, exactly `block.timestamp`, `block.timestamp - 1`,
  `block.timestamp + MAX_START_LEAD`, `+ MAX_START_LEAD + 1`, and `type(uint64).max`. Confirm each
  behaves as the interface states in both `createAuction` and `setStartTime`. Confirm no overflow
  in `block.timestamp + MAX_START_LEAD` under `unchecked`.
- Moving `startTime` earlier cannot shorten or skip the `duration` window once a bid lands; the
  end clock is `firstBid + duration`, and extension windows behave the same for a scheduled auction
  as for an immediate one.
- A scheduled auction with no bid can sit for up to `MAX_START_LEAD` plus `MAX_DURATION` with the
  lot escrowed. Confirm the seller can always cancel and reclaim during that time and that no
  third party can force settlement, claim, or a transfer of the lot.
- `settle` on an auction that never received a bid: confirm the outcome (revert, or settle with no
  winner) matches the interface and cannot strand the lot.

Escrow and value

- No sequence of `bid`, `withdraw`, `settle`, `claimProceeds`, `claimLot`, `cancelAuction`,
  `setStartTime` leaves a card or ETH in the house that no address can withdraw.
- The `mintStart` gate on `Shapes` still applies to ETH-backed bids through the escrow. A scheduled
  auction whose `startTime` is before `mintStart` cannot mint cards before `mintStart`.
- Card bids and ETH bids on the same auction: the standing bid is always the higher one by units,
  the increment check uses the right base, and a losing bidder's cards return intact.

Owner token as lot

- Escrowing token #0 moves `Shapes.owner()` to the house and back to the seller on `claimLot` after
  cancel, or to the winner on `claimLot` after settle. Confirm `owner()` never points at the house
  after the lot leaves and that nothing in `Shapes` grants the holder of `owner()` authority.
- The deployer is an EIP-7702 delegated EOA. Confirm `createAuction` from it, and `claimLot` back
  to it, work when `msg.sender` has code, including the ERC-721 `safeTransfer` receiver check if
  the house uses one.

House replacement

- `Shapes.setPointer` to the new house: admin only, the ERC-165 gate, the lock state. Confirm the
  pointer is still unlocked on the live token and that the deploy script does not lock it.
- The old house at `0x90b7…32df` keeps its code. Confirm nothing in the new house, the token, or
  the site depends on the old house being unreachable, and that a stale `market()` reader is the
  only consequence of the pointer moving.
- `script/deploy.sh` existing-token mode: every guard runs (record present, record `shapes`
  matches `SHAPES_ADDRESS`, main-branch and clean-tree guards, `ATTEST_ARTIST` refused). The script
  passes `--slow` for the delegated deployer. The listing step refuses a start more than
  `MAX_START_LEAD` past the RPC's latest block and refuses when token #0 is already listed. The
  record it writes carries the new `auctionHouse`, its `fromBlock`, and `auctionId`.
- `Deploy.s.sol` postflight: it asserts the new house's `shapes()` is the live token, both interface
  ids are reported, and `market()` points at the new house after the pointer move.

## Required adversarial review

For each item, attempt an exploit in a Foundry test under `test/audit/` before concluding it is
safe. Keep the test even when it fails to exploit; it documents what you tried.

1. Front-run `setStartTime(id, 0)` with a bid in the same block, from both orderings, and from a
   bidder that reenters through a card transfer.
2. Seller sets `startTime` a year out, a bidder's ETH sits nowhere (no bid possible), then seller
   cancels and relists the same token on the same house and on a second house. Confirm the
   one-auction-per-token mapping and `owner()` are correct after each step.
3. `setStartTime` on someone else's auction, on a settled auction, on a cancelled auction, on a
   claimed auction, and on auction id `type(uint256).max`.
4. A lot contract whose `transferFrom` reenters `setStartTime` or `cancelAuction` during
   `createAuction` and during `claimLot`.
5. Time boundaries: `bid` at `startTime - 1` and at `startTime`; `setStartTime` to
   `block.timestamp + MAX_START_LEAD` at a block timestamp near `type(uint64).max` (use `vm.warp`).
6. The full operator sequence on a mainnet fork (`test/Fork.t.sol` style, `MAINNET_RPC_URL`):
   deploy the new house against the live token, `setPointer`, `createAuction` for token #0 from
   the deployer with `startTime` one year out, `setStartTime` to now, bid, settle, `claimLot`,
   `claimProceeds`. Then the cancel branch: `createAuction`, `cancelAuction`, `claimLot`. Assert
   `owner()`, `market()`, card balances and ETH at every step.
7. Grief the scheduled listing: any third-party call that changes `startTime`, `endTime`,
   `highestBidder` or the escrowed lot before the seller opens bidding.

## Known decisions, not findings

Do not report these:

- `startTime` is public on chain. Hiding it in the site is presentation only.
- Opening the auction is a manual `setStartTime` by the seller; there is no keeper.
- `MAX_START_LEAD` is 365 days by design, larger than `MAX_DURATION`.
- The end clock starts at the first bid, never at `startTime`.
- The old house stays deployed and reachable; its auction 0 is settled and claimed.
- `Shapes.market()` is discovery only. Moving it grants and revokes nothing.
- `setStartTime` carries no reentrancy guard; it makes no external call.
- Items listed under "Known decisions" in `AUDIT_PROMPT_v9.md` still hold.

## Prior audit artifacts

Form your own view first. Afterward, compare against:

- `AUDIT_REPORT_v9_claude.md`
- `AUDIT_REPORT_v9_codex.md`
- `AUDIT_PROMPT_v9.md` (the full-system brief; its house section is the baseline this delta
  extends)

## Deliverable

A single Markdown report with:

1. A findings table: id, severity (Critical, High, Medium, Low, Informational), title, `path:line`,
   one-line impact.
2. One section per finding: description, exact reproduction (the `test/audit/` test name),
   impact, recommended fix, and whether the fix changes ABI, storage layout or behavior.
3. A section "Properties verified" listing each property above with the evidence you used
   (test name, trace, or reasoning) and any caveat.
4. A section "Trust model" with the table from step 1 of the trust model and the interface id
   comparison from step 3.
5. A section "Deploy procedure" stating whether the existing-token deploy path is safe to run
   against mainnet as written, and any step the operator must do by hand.
6. A section "Not exploitable, worth knowing" for behaviors that surprised you but are safe.

Severity means impact on real ETH, on escrowed cards, or on token #0 ownership for mainnet
users. Style, naming and documentation observations go in an appendix, not in the findings
table. Do not propose refactors. Do not soften a finding because a test exists; a passing test
is a claim, not a proof.
