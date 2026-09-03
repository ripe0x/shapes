# Audit brief: Shapes architecture release (local AI audit)

You are an independent smart-contract security auditor running locally against a checked-out
repository. Audit the fixed snapshot below as code intended to custody real ETH and redeemable
ERC-721 assets on Ethereum mainnet. Report findings. Do not change files under `src/`. Put any
proof-of-concept tests under `test/audit/` only.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
branch      claude/contracts-page
commit      7f6ccb5
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
anvil --port 8560 &  # then: RPC_URL=http://127.0.0.1:8560 script/deploy.sh anvil && RPC=http://127.0.0.1:8560 script/e2e-anvil.sh
```

Expected at this commit: 532 Foundry tests pass in both profiles, 4 fork tests pass, Medusa
properties pass. Treat these as evidence, never as a substitute for your own reasoning.

## System model

Shapes wraps ETH into ERC-721 tokens at nine fixed denominations. A live token that is not Black is
backed by exactly one denomination. Burning it through redemption returns exactly that amount.
Compose, decompose and split restructure tokens and move no ETH. `burnBacking` sends an apex
token's backing to the fixed unspendable address and marks the token Black; the token stays alive
and can never redeem.

One contract is the protocol: `Shapes`. It owns the reserve, the token, the state machine and every
protocol fact. Two public libraries are linked at deploy time and run through `DELEGATECALL` in
`Shapes` storage context: `RecompositionOps` (compose, decompose, split, their previews, and the
decoded record reads) and `AdminOps` (configuration writes). `ShapeRenderer` is a pure renderer.
`ShapeCollection` holds collection-level metadata and the metadata copy (name prefix and
description). `ShapeAuctionHouse` is an independent application registered as the `market` pointer.

Reserve invariant, every block:

```text
address(this).balance >= redeemableBacking() + pendingFees()
```

Equality holds in normal use. ETH forced into the contract outside its payable entrypoints is not
withdrawable. `burnedBacking()` counts ETH that has already left to the unspendable address.

Read `project/ARCHITECTURE.md` first, then the sources in this order: `src/ShapeTypes.sol`,
`src/Shapes.sol`, `src/lib/RecompositionOps.sol`, `src/lib/AdminOps.sol`,
`src/ShapeCollection.sol`, `src/ShapeAuctionHouse.sol`, `src/ShapeCardEscrow.sol`,
`src/ShapeRenderer.sol`, every file under `src/interfaces/`, then `script/Deploy.s.sol` and
`script/deploy.sh`.

## Trust model to verify, not assume

1. Every library entry is reached only through a `Shapes` external function that runs the access
   check first. List every `Shapes` function that delegates, the check it runs, and the library
   function it reaches. Find any path where a check is missing or runs after a state write.
2. The libraries write only the structs `Shapes` hands them. Confirm no library touches ERC-721
   storage, moves ETH, changes the admin address, or moves the owner token. Then go further: a
   `DELEGATECALL` library runs in the token's storage context, so a bug in a library is a bug in
   the token. Audit the library bodies with the same rigor as `Shapes`.
3. A direct call to a library at its own address cannot affect `Shapes`. `test/LibraryIsolation.t.sol`
   claims solc's call protection reverts such calls; verify the claim against the deployed
   bytecode semantics, including `view` and `pure` library functions.
4. The link is fixed at deploy time. Confirm there is no setter, no proxy, no `CREATE2` trick that
   could redirect a library call after deployment.

## Properties to falsify

Reserve and ETH

- No sequence of calls makes `address(this).balance < redeemableBacking() + pendingFees()`.
- Redemption updates accounting and burns the token before sending ETH. A receiver that reverts or
  reenters cannot extract more than its backing or leave a burned token counted.
- `burnBacking` moves the exact backing from `redeemableBacking` to `burnedBacking`, sends it to
  the unspendable address, marks the token Black, and never lets a Black token redeem.
- `withdrawFees(recipient)` sends exactly `feesOwedTo(recipient)` and nothing from the reserve;
  summed across every recipient a fee has ever accrued to, that equals `pendingFees()`.
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
- Previews: `previewCompose(account, ...)` and `previewSplit(account, ...)` run the same validation
  as the mutators through shared helpers. Find any input where the preview succeeds and the
  mutation reverts, or the reverse.
- Narrowing casts (`uint96` ids, `uint32` origin counts and child indexes, `uint64` split record
  index): confirm each is proven by an invariant in code or reachable only past an economic bound,
  and say which.

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
5. Fee accounting across `setMintFee`, `setFeeRecipient`, `withdrawFees` and batch mints, including
   a fee recipient that is a reverting contract.
6. `mintStart` boundary at exactly the timestamp, and any path that mints before it.
7. Library isolation: call every public library function at the library address with crafted
   storage slot arguments; confirm `Shapes` state is unchanged.
8. Presentation lock ordering: set a new collection after locking, edit copy after locking,
   replace the renderer with one that reverts or returns oversized data.
9. Auction paths: bid, outbid, settle, claim, cancel, with the owner token as the lot and with
   ETH-backed bids before and after `mintStart`.

## Known decisions, not findings

Do not report these; they are recorded in `project/DECISIONS.md`:

- `owner()` names the holder of the owner token and grants no authority (D-24, D-37).
- Redeeming or burning the owner token ends collection ownership; nothing inherits.
- `burn(uint256)` is owner-only, stricter than the draft standard it follows.
- `blackShapeCount` is a live count; `burnedBacking` is cumulative.
- Compose and decompose pay a delegatecall boundary (about 1 to 3 percent gas).
- The `positions` pointer has no implementation yet.

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
