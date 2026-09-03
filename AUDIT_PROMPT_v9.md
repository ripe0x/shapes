# Audit brief: Shapes architecture release (local AI audit)

You are an independent smart-contract security auditor running locally against a checked-out
repository. Audit the fixed snapshot below as code intended to custody real ETH and redeemable
ERC-721 assets on Ethereum mainnet. Report findings. Do not change files under `src/`. Put any
proof-of-concept tests under `test/audit/` only.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
branch      claude/contracts-page
commit      34d2c3b
phase       pre-mainnet; Sepolia rehearsals only
```

Check out that commit before reading anything. Everything you cite must carry `path:line` from
this commit.

## How to run

```bash
forge build --sizes
forge test
FOUNDRY_PROFILE=testnet forge test
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract Fork -vv
ln -sf project/experiments/medusa-reserve.json medusa.json && medusa fuzz --config medusa.json; rm -f medusa.json
anvil --port 8560 --gas-limit 5000000000 &  # then: RPC_URL=http://127.0.0.1:8560 script/deploy.sh anvil && RPC_URL=http://127.0.0.1:8560 LIFECYCLE_INDEXER_PORT=42069 script/lifecycle.sh anvil
```

Expected at this commit: 669 Foundry tests pass and 4 are skipped (fork tests, skipped without
`MAINNET_RPC_URL`) in both profiles, matching `forge test` and `FOUNDRY_PROFILE=testnet forge
test`. With a fork RPC, the same 4 fork tests in `test/Fork.t.sol` pass instead of skipping.
`MedusaReserveHarness` exposes three properties: `property_reserve_equals_redeemable_backing`,
`property_reserve_is_solvent`, `property_owner_token_tracks_its_holder`; all three pass. `Shapes`
measures 22,460 runtime bytes, 2,116 bytes of EIP-170 margin. Treat these as evidence, never as a
substitute for your own reasoning.

## System model

Shapes wraps ETH into ERC-721 tokens at nine fixed denominations. A live token that is not Black is
backed by exactly one denomination. Burning it through redemption returns exactly that amount.
Compose, decompose and split restructure tokens and move no ETH. `burnBacking` sends an apex
token's backing to the fixed unspendable address and marks the token Black; the token stays alive
and can never redeem.

One contract is the protocol: `Shapes`. It owns the reserve, the token, the state machine and every
protocol fact. Three public libraries are linked at deploy time and reached through `DELEGATECALL`:
`RecompositionOps` (compose, decompose, split, their previews, and the decoded record reads) and
`AdminOps` (configuration writes) each take a `Shapes` storage pointer as their first argument and
run in `Shapes` storage context. `GeometrySampling` is pure, takes no storage pointer, and is called
by both `RecompositionOps` and the token itself purely for its module-sampling arithmetic; it is
still deployed and linked separately rather than inlined, so a direct call to it reaches the same
bytecode with no ability to read or write `Shapes` storage. `ShapeRenderer` is a pure renderer.
`ShapeCollection` holds collection-level metadata: the token name prefix, the shared description,
and the owner token's own description, written together by `setMetadataCopy(string,string,string)`
and gated on the admin of the `Shapes` it is bound to. `ShapeAuctionHouse` is an independent
application registered as the `market` pointer.

Fees accrue per recipient rather than into one shared counter. `_mintBatch` credits each batch's fee
to the fee recipient configured at that call. `feesOwedTo(address)` reads one recipient's own
balance; `withdrawFees(address recipient)` pays exactly that recipient's balance and zeroes only
that entry; `pendingFees()` keeps its selector and returns the running total across every
recipient. `setFeeRecipient` only repoints future accrual; it moves no balance, so fees already
credited to the outgoing recipient stay owed to it. It also rejects `address(this)`, which inside
the delegatecall library is `Shapes` itself: `Shapes` has no payable `receive`, so fees credited to
its own address could never be withdrawn.

Reserve invariant, every block:

```text
address(this).balance >= redeemableBacking() + pendingFees()
```

Equality holds in normal use. ETH forced into the contract outside its payable entrypoints is not
withdrawable. `burnedBacking()` counts ETH that has already left to the unspendable address.

Read `project/ARCHITECTURE.md` first, then the sources in this order: `src/ShapeTypes.sol`,
`src/Shapes.sol`, `src/lib/RecompositionOps.sol`, `src/lib/GeometrySampling.sol`,
`src/lib/AdminOps.sol`, `src/ShapeCollection.sol`, `src/ShapeAuctionHouse.sol`,
`src/ShapeCardEscrow.sol`, `src/ShapeRenderer.sol`, every file under `src/interfaces/`, then
`script/Deploy.s.sol` and `script/deploy.sh`.

## Trust model to verify, not assume

1. Every library entry is reached only through a `Shapes` external function that runs the access
   check first. List every `Shapes` function that delegates, the check it runs, and the library
   function it reaches. Find any path where a check is missing or runs after a state write.
2. The libraries write only the structs `Shapes` hands them. Confirm no library touches ERC-721
   storage, moves ETH, changes the admin address, or moves the owner token. Then go further: a
   `DELEGATECALL` library runs in the token's storage context, so a bug in a library is a bug in
   the token. Audit the library bodies with the same rigor as `Shapes`. `GeometrySampling` takes no
   storage pointer at all; confirm none of its functions read or write any slot, so it cannot
   observe or affect `Shapes` state through the delegatecall boundary it still crosses.
3. A direct call to a library at its own address cannot affect `Shapes`. `test/LibraryIsolation.t.sol`
   and `test/audit/LibraryDirectCall.t.sol` claim solc's call protection reverts such calls for
   `RecompositionOps` and `AdminOps`, and that `GeometrySampling`'s functions (which take no storage
   pointer and are safe to run anywhere) remain callable directly with no effect on `Shapes`. Verify
   the claim against the deployed bytecode semantics, including `view` and `pure` library functions.
4. The link is fixed at deploy time. Confirm there is no setter, no proxy, no `CREATE2` trick that
   could redirect a library call after deployment.

## Properties to falsify

Reserve and ETH

- No sequence of calls makes `address(this).balance < redeemableBacking() + pendingFees()`.
- Redemption updates accounting and burns the token before sending ETH. A receiver that reverts or
  reenters cannot extract more than its backing or leave a burned token counted.
- `burnBacking` moves the exact backing from `redeemableBacking` to `burnedBacking`, sends it to
  the unspendable address, marks the token Black, and never lets a Black token redeem.
- Per-recipient fee accounting: the sum of `feesOwedTo(recipient)` over every address ever set as
  `feeRecipient` equals `pendingFees()` at every point in a call sequence. `setFeeRecipient` moves
  no balance between recipients; the outgoing recipient keeps whatever it was already owed. A fee
  recipient that reverts on receiving ETH blocks only its own `withdrawFees` call, never another
  recipient's, and never the mint path that credited it.
- Compose, decompose and split never change `redeemableBacking` in total.

Recomposition

- Compose burns the inputs, keeps the survivor, and records enough state to undo it.
- Decompose pops exactly one record, restores the survivor's prior state, re-mints inputs under
  their original ids, and never collides with a live id. Records unwind LIFO.
- Split burns the parent and mints children whose denominations sum to the parent's backing; the
  split record lets provenance be reconstructed.
- Owner token: exactly one live token holds it until it is redeemed or burned; compose moves it to
  the survivor, decompose restores it to the recorded input after every restored id exists, split
  moves it to the first child before the children are minted. `owner()` equals
  `ownerOf(ownerToken())` whenever an owner token exists. Find any interleaving of
  `onERC721Received` callbacks that observes `ownerToken()` pointing at a token that does not
  exist.
- Previews: `previewCompose(uint256 survivorId, uint256[] burnIds)` and
  `previewSplit(uint256 tokenId, uint8[] outDenoms)` take no account and check no ownership; every
  other gate is the mutator's, through shared helpers. Find any input where the preview succeeds
  and the mutation reverts for the token's own holder, or the reverse.
- Narrowing casts (`uint96` ids, `uint32` origin counts and child indexes, `uint64` split record
  index): confirm each is proven by an invariant in code or reachable only past an economic bound,
  and say which.

Views and presentation

- Every token-id view on `Shapes` (`svg`, `metadataJSON`, `geometryOf`, `effectiveModulesOf`,
  `moduleAt`) enters `_requireOwned` (or an equivalent existence check) before returning data,
  writes no state, and cannot be made to revert `tokenURI` for a token that otherwise mints and
  transfers cleanly.
- `effectiveModulesOf(tokenId)` returns the same bytes the renderer draws from: confirm parity
  against `moduleAt(tokenId, index)` read index by index, for both a token whose modules are
  grammar-derived from its seed and one whose modules were materialized by a prior compose or
  split.
- `setRenderer` requires the new address to answer ERC-165 true for both `IShapeRenderer` and
  `IShapeGeometry`; find any renderer that answers true for both but returns a geometry
  inconsistent with what it renders, or that stops answering true after being installed.
- `setCollection` requires the new address to answer ERC-165 true for `IShapeCollection` and to
  report `shapes() == address(this)`; `lockPresentation` reverts if no collection is set. Confirm
  neither check can be satisfied by a collection bound to a different `Shapes` instance, and that
  once locked, `ShapeCollection.setMetadataCopy` reads `presentationLocked()` live from `Shapes` on
  every call rather than a cached value.

Minting

- `mintStart` gates every path that creates a new backed token, including ETH-backed auction bids
  through `ShapeCardEscrow`. Token #0 from the constructor is the sole exception.
- Seeds are distinct within a batch and do not affect backing. They are grindable; confirm no
  protocol rule depends on them being unpredictable.
- The mint fee is bounded by the cap and cannot be raised above it by any admin path.

Authority

- `admin()` is the only privileged role. Nothing reads `owner()` or the owner token for
  authorization.
- `lockPresentation` permanently freezes the renderer pointer, the collection pointer, and the
  collection's metadata copy. Confirm `ShapeCollection.setMetadataCopy` reads the lock live and
  cannot be bypassed by replacing the collection before locking or by a stale cached value.
- Pointers: `setPointer` refuses a target that does not answer ERC-165 for the interface its
  reader calls; zero clears; `lockPointer` is permanent. `positionOf` forwards to the positions
  target with a bounded gas stipend and returns zero on any failure or malformed return.
- Artist attestation: one signature per contract, EIP-712 bound to chain id, contract address,
  artist and release hash, canonical ECDSA first then ERC-1271, never replaceable once stored.
- `attestArtist` is the one ungated delegating entrypoint by design. Confirm that anyone relaying
  a valid signature cannot store anything but the artist's own approved hash.

Reentrancy and callbacks

- Mint, redemption, fee and recomposition entrypoints are `nonReentrant`. Inherited ERC-721
  transfers and approvals are not. During `safeTransferFrom` the receiver can redeem the token
  from `onERC721Received`. Enumerate every external call and every callback, and show what state
  each callback can observe and change.
- Self-custody: a transfer of a Shape to the `Shapes` contract itself is blocked on both the safe
  and plain paths. Confirm no path (mint, split, decompose, auction settlement) can leave a token
  owned by `Shapes`.

Auction house and escrow

- The house never receives authority over `Shapes`. Bids in cards and bids in ETH both leave the
  reserve invariant intact. Settlement and claim are pull-based; a reverting recipient blocks only
  its own delivery. Escrowing the owner token moves `owner()` to the house for the auction's life;
  confirm nothing else changes.

Presentation

- `ShapeRenderer` has no owner, setters or mutable state; for the same inputs it returns the same
  output. The renderer and collection cannot affect backing, redemption or accounting.
- Metadata strings are validated as JSON-safe before storage and cannot break `tokenURI` or
  `contractURI` output.

Decompose round trip

- Every observable fact a compose destroyed is restored by the matching decompose: ownership,
  denomination, seed, ink gene, materialized modules, and the owner token pointer when it moved.
  `test/DecomposeRoundTrip.t.sol` exercises this; try to construct a compose and decompose sequence
  that leaves any of those facts different from before the compose.

Storage layout

- Confirm nothing has ever been deployed against an older storage layout for the fields touched
  since the last audited commit (the fee accounting fields in particular moved from one shared
  counter to a mapping plus a running total). Confirm the library isolation tests
  (`test/LibraryIsolation.t.sol`, `test/audit/LibraryDirectCall.t.sol`) pin the current storage
  slots the delegatecall libraries write through, so a future storage reordering in `Shapes` would
  fail those tests rather than silently corrupt library writes.

## Required adversarial review

For each item, attempt an exploit in a Foundry test under `test/audit/` before concluding it is
safe. Keep the test even when it fails to exploit; it documents what you tried.

1. Reentrancy from an ERC-721 receiver during `decomposeTo` and `splitTo`, targeting the owner
   token pointer, the reserve, and the record stacks.
2. A malicious positions target that reverts, returns malformed data, consumes all gas, or reenters
   `Shapes` through `positionOf`.
3. Forced ETH (`selfdestruct`, coinbase) and its effect on every view and on `withdrawFees`.
4. A compose record or split record crafted through legitimate calls whose decompose or provenance
   read then misbehaves (duplicate ids, id reuse, zero-length inputs, maximal batch sizes).
5. Per-recipient fee accounting across `setMintFee`, `setFeeRecipient`, `withdrawFees(address)` and
   batch mints, including a fee recipient that is a reverting contract, and a sequence that changes
   `feeRecipient` between mints so two different addresses each accrue a nonzero balance.
6. `mintStart` boundary at exactly the timestamp, and any path that mints before it.
7. Library isolation: call every public library function at the library address with crafted
   storage slot arguments, including `GeometrySampling`'s functions with no storage pointer at all;
   confirm `Shapes` state is unchanged in every case.
8. Presentation lock ordering: set a new collection after locking, edit copy after locking, replace
   the renderer with one that answers ERC-165 true for both `IShapeRenderer` and `IShapeGeometry`
   but reverts or returns oversized data on the actual rendering calls.
9. Auction paths: bid, outbid, settle, claim, cancel, with the owner token as the lot and with
   ETH-backed bids before and after `mintStart`.
10. A renderer or collection that answers ERC-165 true for every interface its gate checks
    (`IShapeRenderer` and `IShapeGeometry` for the renderer; `IShapeCollection` and a matching
    `shapes()` for the collection) but misbehaves on the calls that matter, installed and then
    locked with `lockPresentation`. Confirm the lock still leaves `Shapes` reachable and safe even
    though the presentation surface it now points at permanently is broken.

## Known decisions, not findings

Do not report these; they are recorded in `project/DECISIONS.md`:

- `owner()` names the holder of the owner token and grants no authority (D-24, D-37).
- Redeeming or burning the owner token ends collection ownership; nothing inherits.
- `burn(uint256)` is owner-only, stricter than the draft standard it follows.
- `blackShapeCount` is a live count; `burnedBacking` is cumulative.
- Compose and decompose pay a delegatecall boundary (about 1 to 3 percent gas).
- The `positions` pointer has no implementation yet.
- Fee accrual is per recipient rather than one shared counter (D-43): `setFeeRecipient` only
  repoints future accrual and never moves a balance already credited to the outgoing recipient.
- `setFeeRecipient` rejects `address(this)` because `Shapes` cannot receive and withdraw its own
  fees (D-43).

## Prior audit artifacts

Form your own view first. Afterward, these documents from the prior round are available to compare
against, not to anchor on:

- `AUDIT_REPORT_v8_claude.md`
- `AUDIT_REPORT_v8_codex.md`
- `project/reviews/architecture-security-2026-09-03.md`
- `project/reviews/diff-review-7f6ccb5-2bc389a.md`

## Deliverable

A single Markdown report with:

1. A findings table: id, severity (Critical, High, Medium, Low, Informational), title, `path:line`,
   one-line impact.
2. One section per finding: description, exact reproduction (the `test/audit/` test name),
   impact, recommended fix, and whether the fix changes ABI, storage layout or behavior.
3. A section "Properties verified" listing each property above with the evidence you used
   (test name, trace, or reasoning) and any caveat.
4. A section "Trust model" with the table from step 1 of the trust model.
5. A section "Not exploitable, worth knowing" for behaviors that surprised you but are safe.

Severity means impact on real ETH or on token ownership for mainnet users. Style, naming and
documentation observations go in an appendix, not in the findings table. Do not propose
refactors. Do not soften a finding because a test exists; a passing test is a claim, not a proof.
