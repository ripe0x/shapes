# Shapes

ETH in, Shape out. Shape burned, the same ETH out.

A Shape is an ERC721 token that wraps an exact amount of ETH. Whoever owns a normal Shape owns
the right to unwrap it. Redeem or burn the token and you receive exactly its current value — not
a share of a pool, not a proportion, not an appraisal. The same wei. A deliberately sacrificed
Black Shape has zero remaining value and may be burned for zero.

Between minting and burning, a Shape is an ordinary NFT. Transfer it, sell it, deposit it in
another contract, hold it. The artwork and the token's history make it a distinct object; the
denomination makes it exactly as redeemable as every other Shape of that size.

The contract does not lend the ETH, stake it, invest it, seek yield on it, or use it for
anything. It holds it.

---

## The nine denominations

Shapes does not accept arbitrary amounts. There are exactly nine, and they are permanent:

```
0.01   0.05   0.1   0.5   1   5   10   50   100   ETH
```

Every other amount is rejected. 100 ETH is the maximum.

## Value controls visual density

Higher value means less. The grid contracts as the denomination rises, so a Shape becomes more
concentrated and more monumental the more ETH it holds:

| ETH | Grid | Modules |
|---|---|---|
| 0.01 | 5 × 5 | 25 |
| 0.05 | 4 × 5 | 20 |
| 0.1 | 4 × 4 | 16 |
| 0.5 | 3 × 4 | 12 |
| 1 | 3 × 3 | 9 |
| 5 | 2 × 3 | 6 |
| 10 | 2 × 2 | 4 |
| 50 | 1 × 2 | 2 |
| 100 | 1 × 1 | 1 |

0.01 ETH is maximum complexity. 100 ETH is irreducible: one module, alone on a black field.
Nothing is added to compensate for the space.

## How seeds create unique compositions

Value sets the grammar; the seed writes the sentence. Each token receives an immutable
`bytes32` seed at mint. The seed decides, for every cell in the grid, which primitive lands
there, whether it is solid or drawn, and how it is rotated. The vocabulary is ten primitives:
eight fillable forms — circle, square, triangle, half circle, quarter circle, diamond, half
square and right triangle — plus two open strokes, an arc and a diagonal line, that are always
outlined. Circle, square and diamond are rotation-invariant; the rest take one of four
rotations, except the line, which takes one of two. That is 52 distinct module appearances. Two
card-level draws set a single size and a single stroke weight shared by every module on that
token, so a card reads as one decision rather than a collection of them.

How solid a card is comes from its ink gene, a seven-state trait (`Void` through `Solid`) set at
mint and carried through composition. The gene sets the probability each mark is drawn solid
rather than outlined: 0% at `Void`, 100% at `Solid`, and a spread between. It is surfaced as the
`Ink` trait. A separate `Fill` trait reports how the card actually painted — `Solid` if every
mark came out filled, `Outline` if none did, `Mixed` otherwise. The arc and the diagonal line are
outline only, so a card carrying one never reads fully `Solid`. Ink genes are detailed in
SPEC.md D17; every trait is documented in METADATA.md.

Because size and stroke are collection constants, the composition space is finite: enormous at
the dense denominations, but exactly 2,704 at 50 ETH and **52 at 100 ETH**, where a card is a
single module. A 100 ETH Shape is one of fifty-two archetypes, and that is deliberate — see
SPEC.md D15. Each Shape remains a distinct object regardless: unique token number, unique seed,
its own provenance.

Every mark on a card paints to exactly the same distance from its cell centre — the same for
each primitive, solid or outlined. An outlined mark with corners is drawn as a filled ring
whose outer edge is the solid geometry itself, so the two forms of a shape share their exact
silhouette. Each footprint is solved backwards from the target rather than measured after the
fact, so a mark can never overflow its cell and collide with its neighbour. See SPEC.md D13
and D16.

The seed determines artwork and nothing else. It has no economic effect: redemption value comes
from the denomination alone, so every 1 ETH Shape redeems for exactly 1 ETH regardless of what
it looks like.

Two Shapes of the same denomination are economically equivalent at the redemption layer and
remain distinct historical objects. That is the whole design.

---

## Minting

Minting is permissionless from the immutable `mintStart` timestamp onward. Before it, `mint`,
`mintTo`, `mintBatch`, `mintBatchTo`, and ETH-backed auction bids that mint through them all
revert `MintNotOpen()`. Shape #0 is minted unconditionally in the constructor, so it can be
transferred, listed for auction, and redeemed before `mintStart`.

```solidity
mint(uint256 amountWei) payable returns (uint256 tokenId)
mintTo(uint256 amountWei, address to) payable returns (uint256 tokenId)
mintBatch(uint256 amountWei, uint256 quantity) payable returns (uint256 firstTokenId)
mintBatchTo(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)
```

You send the backing **plus the flat fee for each Shape created**:

```
mint a 1 ETH Shape   ->  msg.value = 1 ETH + 0.001 ETH = 1.001 ETH
                         the NFT's redemption value = exactly 1 ETH

ten 1 ETH Shapes     ->  msg.value = 10 x 1.001 ETH = 10.01 ETH
                         backing obligation = exactly 10 ETH
```

The value must be exact — over and under both revert. Each token in a batch gets its own id and
its own seed.

## The mint fee

The mainnet deployment's initial value is a flat **0.001 ETH per Shape created**, independent of
backing. `admin()` may adjust `mintFee` afterward via `setMintFee`, up to the compile-time cap
one denomination unit (`unit()`), and may redirect `feeRecipient` for future withdrawals. A
100 ETH Shape and a 0.01 ETH Shape each pay the same flat fee. The isolated testnet build scales
the initial fee with its 1/100 denomination ladder to 0.00001 ETH per Shape.

`mintFee()` returns the current per-Shape fee, read live by every mint. Fees accrue to
`pendingFees()` in the same transaction as the mint and never join the reserve; a batch accrues
`quantity * mintFee` once. Anyone may call `withdrawFees()` to forward the accrued total to the
current `feeRecipient` — minting never calls the recipient directly, so a reverting recipient
blocks only the withdrawal, never minting. Redemption is unaffected: a 1 ETH Shape always redeems
for exactly 1 ETH, fee already paid at mint.

There is no burn fee, no transfer fee, no royalty requirement, and no recurring protocol fee.

## Transfers

A Shape is a normal ERC721. Transfer and approval work as expected. Redemption rights follow the
token: the current owner can always unwrap it, and a previous owner cannot.

One deliberate refusal: a Shape cannot be minted or transferred to the `Shapes` contract itself.
The contract can never be `msg.sender`, so such a token could never be redeemed.

## Redemption

```solidity
redeem(uint256 tokenId)
burn(uint256 tokenId)
redeemBatch(uint256[] calldata tokenIds) returns (uint256 totalWei)
```

The current owner burns the token and receives its exact backing, paid directly to them. All or
nothing — there is no partial redemption and no direct way to add ETH to an existing Shape.
Recomposition may move backing between identities, and sacrifice may change an apex's value to zero.

`redeemBatch` burns each token, then makes a single transfer of the exact total.

`burn` is the draft ERC-8060 entry point. For a normal Shape it is economically identical to
`redeem`; for a Black Shape it destroys the zero-value token without transferring ETH. Both are
owner-only — an approved operator can transfer a Shape but cannot directly redeem or burn it.

`backingOf(tokenId)` and `valueOf(tokenId)` return the same exact currently redeemable native ETH.
Both revert for nonexistent or consumed IDs, and both return zero for a live Black Shape. Shapes
implements the current draft `IERC721Value` interface (`valueOf` + `burn`) and advertises it through
ERC-165; the draft may still change before finalization.

`exists(tokenId)` is the non-reverting liveness check: it is true for every live token, including
Black, and false for never-issued, redeemed, publicly burned, split-parent and compose-consumed
IDs. `denomIndexOf(tokenId)` returns the live token's stored ladder index from 0 through 8 and
reverts for a nonexistent ID. A Black Shape keeps index 8 even though its redeemable value is zero.

If the ETH transfer fails, the entire redemption reverts. The token survives and the backing
stays put.

## Recomposition and identity

`compose` combines several Shapes into a caller-selected survivor. Their exact backing and origins
move onto that survivor; the other input IDs are consumed into a reversible LIFO record.
`decompose` reverses the latest compose and revives those exact identities. Separately, `split`
consumes one Shape and mints fresh child IDs whose denominations sum exactly to the parent. A split
is final. None of these operations moves ETH or calls either external pointer.

New token IDs are issued sequentially using `totalMinted` as the next ID and issued-count. IDs
retired by redemption, public burn or split are never reassigned. The deliberate exception is
reversible compose: `decompose` revives the exact inputs recorded by that compose without issuing
new IDs. Positions attach to Shape identity, not automatically to ETH material that later moves
into another ID.

## Sacrifice and Black Shapes

`sacrifice(tokenId)` is an owner-only transformation available only to a Complete 100 ETH apex.
It sends exactly 100 ETH to `0x…dEaD`, changes the token's current value to zero and marks it Black
without burning it. The same ID, owner, seed, provenance and artwork geometry remain; metadata is
updated to the inverted Black rendering. A Black Shape stays transferable and may be burned for
zero, but it cannot be redeemed, composed, decomposed or sacrificed again.

`sacrificedBacking` and `blackCount` are cumulative historical counters. Burning a Black Shape does
not reduce either one.

## Optional external positions and market

`positions()` and `market()` expose two explicit canonical ecosystem pointers, each paired with its
independent permanent lock state. Both launch at `(address(0), false)`. Canonical means the contract
surfaced by Shapes, not exclusive: anyone may build alternatives.

`ShapeLens.positionOf(tokenId)` queries the configured positions contract. With no positions target
it returns zero immediately. The target defines aggregation and position lifecycle; the lens does
not check token existence, backing, claim validity or authorization. Reverts, excessive gas use and
malformed results return zero. A malicious target can mislead this view but cannot affect ownership,
backing, redemption, burn, recomposition, rendering or reserve solvency. Core state-changing Shape
operations never call either pointer.

The intended future protocol is an external exchange-option layer. A creator escrows claim assets
against a live Shape, records its current `valueOf` and an expiry, but keeps the Shape itself as an
ordinary transferable NFT. The current Shape holder may later transfer that Shape to the creator
in exchange for the escrowed claim. A missing Shape, value mismatch or expiry prevents exercise and
lets the creator recover the claim. A gacha can separately custody the Shape while offering it as a
prize. Shapes itself never freezes tokens, escrows claims, wraps ownership or executes positions.

---

## The reserve

The invariant, always:

```
address(this).balance >= redeemableBacking()
```

In normal operation it is equality. It is stated as an inequality because Ethereum can force
ETH into any address through mechanisms outside `receive` — `selfdestruct`, block rewards,
pre-deployment funding. Any such surplus is permanently inaccessible. That is the intended
outcome: stranding a few stray wei is strictly better than opening a withdrawal path that could
reach the reserve.

Direct ETH transfers to the contract revert. ETH arrives through the constructor-backed mint of
Shape #0 and through later mints once `mintStart` has passed.

Every wei counted by `redeemableBacking()` corresponds to a live non-Black Shape. Stateful
invariants cover minting, transfer, redemption, burn, composition, decomposition, splitting,
restoration, sacrifice, forced ETH and `valueOf == backingOf`; unit tests pin high-water issuance
and the narrow compose/decompose identity-revival exception.

## Immutability

One live Shape is the owner token, and `owner()` always returns its current holder. It starts as
#0, minted atomically to the deployer with minimum-denomination backing, and is otherwise a normal
Shape: it can be transferred, redeemed, composed, decomposed, or split. A compose that absorbs it
moves it to the survivor, the matching decompose restores it to that input, and splitting it gives
it to the first output. Redeeming or burning the owner token ends collection ownership
permanently: `owner()` returns zero and no other token inherits. Its metadata name is the ordinary
token name suffixed with `, Contract Owner` (e.g. `Shape 5, Contract Owner`), with the exclusive
value-only attribute `"Contract Owner"` (no `trait_type`). Holding it grants no administrative
rights. Permissionless artwork minting starts at #1 and opens at the immutable `mintStart`
timestamp; no admin path can move it.

The deployer is also recorded permanently as `artist()`. This is attribution only: it cannot move
ETH, administer metadata, receive fees, control the owner token, or authorize any operation. The artist may
submit one EIP-712 signature directly to Shapes, or have anyone relay it, approving the exact chain,
Shapes address, artist address and chosen `releaseHash`. `artistSignature()` and
`artistReleaseHash()` then remain onchain permanently, along with proof that the signature was valid
when `attestArtist` executed. Stateless digest and signature checking live in the reusable linked
`EIP712Signature` library; all attribution state remains in Shapes.
EOA signatures and ERC-1271 smart-wallet signatures are supported. There is no artist statement or
artist-controlled mutable text.

A separate `admin()` role controls presentation, positions, market configuration and the
destination of future mint fees. It can be
transferred through `transferAdmin` or permanently removed through `renounceAdmin`, independently
of the owner token:

- Presentation: the renderer and collection metadata contracts may be replaced until
  `lockRenderer` permanently freezes both pointers. The metadata copy, the token name prefix and
  description shared by token and collection metadata, is edited via `setMetadataCopy` and is not covered by `lockRenderer`; it stays editable
  for as long as an admin remains. Copy is validated so it cannot break the metadata
  JSON. All of it is read only by metadata views and cannot affect backing, redemption or ownership.
- The positions and market pointers may each be set, replaced or cleared through `setPointer` until
  `lockPointer` permanently freezes that entry. Pointer id 0 is Positions and 1 is Market; other
  ids revert. Either entry may be locked while zero.
- `setFeeRecipient` redirects only future `withdrawFees` calls. It cannot recover fees already
  withdrawn, withdraw ETH itself, or reach backing or redemption.
- `setMintFee` changes the per-Shape fee, up to the compile-time cap of one denomination unit (`unit()`). It takes
  effect for every later mint and for the auction house's ETH-bid card minting, which reads the
  fee live. It cannot touch backing, redemption or already-accrued fees.

Locking freezes the stored address, not the target's code or trust model. Renouncing admin makes
every still-unlocked pointer practically permanent because no caller can pass the admin check,
and freezes the mint fee and the current fee recipient at their last values.

The reserve, denominations and redemption path have no admin access at all. Deliberately absent:
emergency withdrawal, treasury withdrawal, redemption pause, asset recovery, backing modification,
token seizure, upgradeability, proxies, allowlists, supply caps, royalties.

There are three value-bearing external calls: `withdrawFees`'s transfer of accrued mint fees,
settlement after redemption or burn, and the fixed 100 ETH sacrifice to `0x…dEaD`. No
administrative function reaches any of them.

See [`SECURITY.md`](SECURITY.md) for the adversarial review, including the findings that were
fixed and the residual risks that were accepted deliberately.

## Fully onchain artwork

`tokenURI` returns a base64 `data:application/json` URI. Its `image` field is a base64
`data:image/svg+xml` URI. Both are generated by `ShapeRenderer` at call time from the token's
stored seed and denomination.

No IPFS, no Arweave, no external images, no external APIs, no fonts of any kind, no server. The
canvas is a `0 0 250 350` viewBox — 2.5 × 3.5 trading card proportion — black background, white
artwork, no other colours, no gradients, no filters.

**A Shape carries no type.** No title, no denomination, no token number on the face — just the
marks. The value and the number live in the metadata. One consequence: artwork is a pure
function of seed and denomination, so `renderSVG` does not take a token id at all.

A token's artwork is a pure function of its seed and denomination for a given renderer, and both
are fixed at mint. The admin can replace the renderer to correct a rendering bug — which would
re-derive every token's artwork through the new code — until `lockRenderer` makes the renderer,
and so the artwork, permanent.

---

## Repository

```
src/
  Shapes.sol             ERC721 + the reserve
  ShapeRenderer.sol      fully onchain SVG and metadata
  ShapeLens.sol          read-only periphery, split out to stay under the EIP-170 limit
  ShapeCollection.sol    collection-level presentation, seeded previews of unminted cards
  ShapeAuctionHouse.sol  English auction for any ERC721, bids denominated in Shape cards
  ShapeCardEscrow.sol    custody and valuation for bids made of Shape cards
  interfaces/
    IShapes.sol
    IERC721Value.sol
    IShapeRenderer.sol
    IShapePositionResolver.sol
    IShapeLens.sol
    IShapeCollection.sol
    IShapeAuctionHouse.sol
    IShapeCardEscrow.sol
    IShapeGeometry.sol
    IShapeCapabilities.sol
    IAdminControl.sol
  lib/
    Denominations.sol         the nine amounts and their grids
    FixedPoint.sol            WAD arithmetic + the canonical decimal formatter
    Round03Rand.sol           the deterministic random stream
    ComposeCompute.sol        module sampling and ink gene assignment in one call
    AdminOps.sol              artist attestation, metadata copy, and fee-config mutators
    CopyValidation.sol        UTF-8 and JSON-safety validation for owner-editable copy fields
    EIP712Signature.sol       reusable deployment-bound digest and EOA/ERC-1271 verification
    PointerOps.sol            positions/market pointer configuration and one-way locks
    GeometrySampling.sol      the compose and split module-sampling procedures
    GrammarV1Modules.sol      module-identity byte sequence for an original token under grammar v1
    InkGenes.sol              the seven-state ink gene: assignment, inheritance, pool statistic
    ModuleCodec.sol           one-byte encoding for a module's kind, solid, and rotation
script/
  Deploy.s.sol                the one deploy script, run for anvil, Sepolia, and mainnet alike
  deploy.sh                   the one wrapper: script/deploy.sh <anvil|sepolia|mainnet>
  env/                        anvil.env, sepolia.env, mainnet.env, values only, no secrets
  DeployLens.s.sol            replacement lens for an already-deployed Shapes
  LensEquivalence.s.sol       deploy-time proof that a lens previews what the token executes
  SeedShapes.s.sol            seeds an already-deployed Shapes; no seeding inside Deploy.s.sol
  e2e-anvil.sh                live end-to-end check against a local chain, via deploy.sh anvil
  fork-dev.sh                 local Anvil + deploy + funded wallet, for the frontends
test/
  Shapes.t.sol                minting, fees, redemption, reserve security
  ShapeRenderer.t.sol         stream, formatter, geometry, metadata validity
  Parity.t.sol                byte-identical output vs the TypeScript fixtures
  Hardening.t.sol             regressions for the adversarial review findings
  Invariants.t.sol            stateful solvency invariants
  Fork.t.sol                  full lifecycle against a mainnet fork (env-gated)
  fixtures/fixtures.mainnet.json  generated default-ladder corpus, do not hand-edit
  fixtures/fixtures.testnet.json  generated testnet-ladder corpus, do not hand-edit
preview/                      the generative preview harness + chain tester
netlify.toml                  repository-root Netlify config; builds the web workspace
SPEC.md                       implementation plan and every rendering decision
SECURITY.md                   adversarial review
BUILDING.md                   integrator's guide: accept, unwrap and reshape Shapes from a contract
METADATA.md                   the tokenURI trait reference
```

`SPEC.md` is worth reading before changing anything in the renderer. It records the decisions
the visual specification left open and the two places where the design reference and the
protocol specification actually disagreed.

## Running the tests

```bash
forge install          # if lib/ is not vendored
forge build
forge test
forge test --mc Parity        # byte parity with the TypeScript renderer
forge test --mc Invariant     # reserve solvency under fuzzed sequences
FOUNDRY_PROFILE=ci forge test # heavier fuzzing

# Line and branch coverage. --ir-minimum is required because coverage builds without the
# optimizer and the renderer's string assembly exceeds the stack limit otherwise; --skip script
# excludes the deploy scripts, which are tooling rather than audited contracts and carry the
# same stack pressure. test/legacy/ holds the pre-refactor renderer that RendererDiff.t.sol
# compares against: it is deliberately the flat form, which is exactly what cannot survive
# coverage's codegen, so it is excluded too. --no-match-test Gas drops the two gas-ceiling
# assertions, which measure the optimized build and trip under coverage's unoptimized one.
forge coverage --ir-minimum --skip script \
  --skip 'test/legacy/*' --skip 'test/RendererDiff.t.sol' --no-match-test Gas --report summary
```

### Against a mainnet fork

Shapes reads no external contract, so a fork is not needed for correctness. What it adds is a
real block environment — chain id 1, a post-merge `prevrandao`, a real prior blockhash and
timestamp, all of which feed the mint seed — plus realistic gas. `ForkTest` deploys through the
actual deploy script under those conditions and drives mint, transfer, redeem and batch redeem
end to end, asserting the reserve invariant and exact payouts. It is gated on `MAINNET_RPC_URL`
and skipped when unset, so the default `forge test` is unaffected.

```bash
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc ForkTest -vv
```

One thing the fork surfaces that a clean chain cannot: a freshly deployed address can coincide
with a mainnet account already holding a little ETH, and many mainnet EOAs now carry an EIP-7702
delegation. The suite treats the former as stranded surplus (`balance >= redeemableBacking` still
holds) and mints only to codeless recipients, matching how the contract behaves in the wild.

## Running the site locally

The full flow — local chain, deployed contracts, funded wallet, mint frontend — is two commands
in two shells, from the repo root.

First shell — anvil, deploy, seed wallet funding. Leave it running:

```bash
./script/fork-dev.sh
```

Second shell — the dev server; then open https://preview.shapes.localhost/site.html
(or http://localhost:5173/site.html):

```bash
cd preview && portless
```

Dev servers run through [portless](https://portless.sh) (`npm install -g portless`), which gives
each app a stable named URL on top of its fixed port. `web` is `shapes.localhost`, `preview` is
`preview.shapes.localhost`; in a git worktree the worktree name is prefixed
(`<worktree>.preview.shapes.localhost`). The command prints the exact URL on start. Run
`portless service install` once to keep the proxy on port 443 across reboots; without it the
proxy falls back to port 1355 and URLs carry that port. `npm run dev` still works directly on
the plain localhost ports.

`fork-dev.sh` boots Anvil on `:8545` (chain id `31337`), deploys Shapes and the renderer through
the real deploy script, funds the default seed wallet with 1000 ETH (`SEED_WALLETS` /
`SEED_ETH` to change), and writes `preview/public/deployment.json`, which the Vite preview reads
on load. The Next site reads `web/public/deployment.json`, which is updated only for a real public
deployment. Every local run is a fresh chain; prior tokens are gone.

For a chain that looks like the project has run for weeks, use `script/lived-in.sh` instead of
the two commands above. One command from the repo root:

```bash
./script/lived-in.sh
```

This boots (or reuses) the dev chain, deploys the contracts, then runs
`preview/scripts/simulateHistory.ts` against it: roughly six weeks of dated activity across 30
wallets, exercising every external function of `Shapes`, `ShapeLens` and `ShapeAuctionHouse`
several times each from different wallets, including full auction lifecycles, and ending with a
curated set of presents sent to the browsing wallet. It then copies the deployment to
`web/public/deployment.local.json` (gitignored, never the tracked `deployment.json`), which the
Next site and its OG image route prefer over the bundled deployment when present. Leaves the
chain running afterward; Ctrl-C stops it.

To seed a shorter, simpler round of activity instead (mints across every denomination,
compositions up to two 100 ETH apexes, one fully built and one half direct, splits, transfers and
redemptions), run it from `preview/`, as many times as you like; each run appends another round:

```bash
npm run simulate
```

The dev server serves three entries:

| URL | What it is |
| --- | --- |
| `/site.html` | **The mint site** — mint, gallery, token detail, redeem, compose / decompose / split |
| `/chain.html` | Chain tester — a development harness against the same deployment |
| `/` | Render harness — the canonical TypeScript renderer, no chain |

## Running the preview harness

```bash
cd preview
npm install
portless               # https://preview.shapes.localhost (also http://localhost:5173)
```

The harness renders the full nine-denomination ladder, generates reproducible batches of up to
500 cards per denomination, exposes every design parameter as a live control while clearly
marking which values the Solidity renderer actually commits to, detects exact geometry
collisions, warns the moment any parameter combination lets a module escape its grid cell,
and reports primitive, fill and rotation distributions. Click any card to inspect
its seed, resolved parameters, module sequence and raw SVG.

The `grid overlay` toggle draws the artwork field (cyan), the derived cell grid (red) and the
cell centres (yellow) over every card, and outlines in orange any mark whose painted extent —
stroke and miter joins included — leaves its cell. It is a display layer only and never reaches
fixtures, exports or the chain. At the committed parameters nothing escapes: the worst case is
89.3% of the half-cell, and the header reports the headroom live. See SPEC.md D13.

### Animations

Turn on `select frames`, click cards in any view to add them in order — a numbered badge marks
each one — and the tray at the foot of the page exports them as an animated GIF. `all N to
animation` in the batch view adds a whole batch at once. Frames can be removed by clicking them
in the tray, and `reverse` flips the order.

Defaults are 700px wide, 32 greys, 250 ms per frame, looping forever, capped at 12 MB. If a
selection would exceed the cap the frame size is reduced until it fits, and the tray says so.

Two details decide how the output looks. The vector is rasterised **at the output size** — the
SVG's intrinsic 250×350 would otherwise be enlarged as a bitmap, halving the real resolution —
and rendered at 2× before being resampled down. And the palette is a **grey ramp, not two
colours**: the fills are only ever black or white, but the edges are not, and quantising to two
colours turns every arc into a staircase. Interiors are still flat runs that compress hard, so
a 700×980 card costs around 11 KB.

The encoder is written rather than imported, so the standalone preview stays a single
self-contained file. It emits a strict GIF89a with a NETSCAPE2.0 looping extension.

```bash
npm run standalone      # build the single-file preview
npm run gif:e2e         # drive the export in a real browser and capture the download
```

Command line equivalents:

```bash
npm run verify         # fidelity check against the Round 03 source
npm run sweep          # 500-sample collision sweep, all nine denominations
npm run sweep -- 2000  # larger sample
```

## Generating fixtures

The TypeScript renderer is the specification; the Solidity renderer is a port of it. Fixtures
are the contract between them.

```bash
cd preview
npm run fixtures                       # writes fixtures.mainnet.json
SHAPES_LADDER=testnet npm run fixtures # writes fixtures.testnet.json
cd ..
forge test --mc Parity
FOUNDRY_PROFILE=testnet forge test --mc Parity
```

Regenerate whenever the canonical renderer changes, and expect the parity suite to fail loudly
if the two implementations disagree by so much as one byte.

## Chain tester

A second preview entry talks to a deployed contract instead of the canonical renderer: deposit
ETH, read the resulting artwork back from the chain's own `tokenURI`, and redeem. It is a
development harness, not the launch surface — Shapes ships contracts-only — but it exercises the
real deposit and withdraw paths and renders the actual onchain SVG rather than the TypeScript
one. `fork-dev.sh` boots a local Anvil, deploys through the real deploy script, and writes the
deployed address to `preview/public/deployment.json`, which the Vite page reads on load. The page
shows the reserve invariant live — contract balance against `redeemableBacking()` — alongside every
Shape the connected account holds.

The chain is a plain local Anvil, not a mainnet fork: Shapes reads no external contract, so a
fork buys the frontend nothing and only drags in mainnet state (EIP-7702 delegations on the
default accounts, inherited nonces) that trips up `_safeMint` and browser wallets. Set
`FORK_URL` to a mainnet RPC if you want a fork anyway; mainnet-fork behaviour is otherwise
covered by `test/Fork.t.sol`.

### With a browser wallet

You sign every mint and redeem in the wallet, against the deployed contract.

1. **Seed the address you will connect** and start the chain. It is funded with 1000 ETH by
   default (`SEED_ETH` to change).

   ```bash
   SEED_WALLETS=0xYourAddress ./script/fork-dev.sh
   ```

   Leave it running. It prints the RPC URL (`http://127.0.0.1:8545` unless `PORT` is set), the
   chain id, the deployed addresses, and the fee in basis points.

2. **Serve the page** in another shell, and open the chain entry.

   ```bash
   cd preview && portless
   # open https://preview.shapes.localhost/chain.html (or http://localhost:5173/chain.html)
   ```

3. **Connect** through the RainbowKit button. Pick the browser wallet and approve the
   connection. If the wallet is on the wrong network the button shows a switch control; approve
   it to add and switch to the local chain. To add it by hand instead, use the RPC URL and chain
   id the script printed, currency symbol `ETH`.

   The chain uses Anvil's standard id, `31337`, which browser wallets already have configured
   for `localhost:8545`. One caveat: a wallet keys networks by chain id, so a second local node
   also on `31337` silently receives transactions meant for this one. Run only one at a time, or
   give the others a different `PORT` and point the wallet's `localhost:8545` entry at whichever
   one you're using.

4. **Mint.** Pick a denomination and mint; the wallet prompts you to sign a transaction sending
   backing plus the fee. Once it confirms, the Shape appears with its artwork fetched from the
   contract's own `tokenURI`, and the reserve readout updates.

5. **Redeem.** Redeem a single Shape or the whole holding; the wallet prompts again, and the
   backing returns to your address. The reserve unwinds to zero (bar any stray wei), the same
   invariant the contract enforces.

Wallet connection is handled by [RainbowKit](https://www.rainbowkit.com/) over wagmi, with only
the injected/browser wallet offered — no WalletConnect relay, since the chain is local. A
browser wallet is required; there is no keyless path.

### Troubleshooting

- **Wallet shows the network as unsupported, or a mint never confirms.** Almost always a chain
  id clash: another local node shares this chain's id, so the wallet holds a different RPC for
  it and routes there. Stop the other node (or point it at a different `PORT`), remove the stale
  network from the wallet, and re-add the one the script prints.
- **Nonce or balance looks wrong after restarting the chain.** The wallet cached state from a
  previous run. Clear the account's activity/nonce data (MetaMask: Settings → Advanced → Clear
  activity tab data) and reload.
- **Port already in use.** `fork-dev.sh` takes `PORT` for Anvil; the page reads whichever RPC
  the script wrote. Vite picks its own free port for the page.

## Deploying

One script, `script/Deploy.s.sol`, deploys every environment: anvil, Sepolia, and mainnet. Chain
id selects the required denomination ladder — mainnet requires the mainnet ladder, Sepolia the
testnet ladder, anvil accepts either — and any other chain id reverts. It sends the minimum
denomination to `Shapes`, which mints backed Shape #0 to the deployer, then asserts every
deployment value landed as intended, smoke-tests the renderer, verifies `artist()` is the
deployer and that Shapes begins with an empty artist release hash and signature, and proves the
lens previews what the token executes (see below) before reporting success.

One wrapper, `script/deploy.sh <anvil|sepolia|mainnet>`, runs it for every target through the
same code path, sourcing `script/env/<name>.env` for the values that differ: chain id, Foundry
profile, default RPC, verify flag, main-branch guard, wallet mode, deployer, fee recipient, mint
fee, mint start, EOA-recipient guard, indexer URL. `DRY_RUN=1` runs the guards and the forge
simulation with no wallet, broadcast, or verification.

```bash
anvil                       # in one shell
./script/deploy.sh anvil    # in another

./script/e2e-anvil.sh       # mint all nine, transfer, redeem, verify
```

Sepolia and mainnet sign with the ripe0x Foundry keystore (interactive prompt, or
`KEYSTORE_PASSWORD_FILE` to read the password from a file instead of a prompt). Both require a
fetched, clean, exact `main` to deploy from; the wrapper checks and refuses otherwise.

```bash
DRY_RUN=1 script/deploy.sh sepolia   # guards + simulation, nothing broadcast or written
script/deploy.sh sepolia             # broadcasts, verifies on Etherscan, records the deployment
```

`script/env/mainnet.env` ships with `DEPLOYER`, `FEE_RECIPIENT`, and `MINT_FEE_WEI` empty; the
wrapper refuses to run, `DRY_RUN` included, until D-05 (`project/DECISIONS.md`) is resolved and
those values are filled in. Once they are, mainnet deploys the same way:

```bash
DRY_RUN=1 script/deploy.sh mainnet
script/deploy.sh mainnet
```

After a real broadcast, the wrapper reads the broadcast artifact, reads back every deployed
contract on chain, polls Etherscan for verified source when `VERIFY=true`, and writes
`deployments/<chainId>.json` with the same key set as `web/public/deployment.json` (`rpc`,
`indexerUrl`, `chainId`, `shapes`, `renderer`, `collection`, `lens`, `auctionHouse`,
`mintFeeWei`, `mintStart`, `fromBlock`). Cutover to the site is a file copy. `deployments/31337.json` is
gitignored; Sepolia and mainnet records are committed.

For Sepolia, `script/attest-artist-sepolia.sh` reads back every binding, displays the exact EIP-712
digest, simulates the call, requires two explicit confirmations, broadcasts through the artist's
Foundry account, and verifies the permanent result. Set `SHAPES_ADDRESS` and the already-decided
32-byte `SHAPES_RELEASE_HASH`; document what that hash commits to before signing. The deploy
wrapper's reported Shapes deployment transaction hash is the `releaseHash` used in this signing
ceremony. Never issue multiple valid signatures for competing hashes because any relayer holding
one can submit it first.

`Deploy.s.sol` also proves the lens previews what the token executes. `ShapeLens.previewCompose`
matches `Shapes.compose` only while both resolve the externally linked `ComposeCompute` to the
same deployment, so the script mints a probe token, splits it, composes it back, and requires the
preview to equal the resulting core state byte for byte. The probe runs in the `forge script`
simulation and is never broadcast: no probe token, no ETH, no token ids consumed.

Redeploying the lens on its own runs the same check against the live token:

```bash
SHAPES_ADDRESS=0x... forge script script/DeployLens.s.sol --rpc-url $RPC   # dry run first
```

## Deployed addresses

| Network | Shapes | ShapeRenderer |
|---|---|---|
| Mainnet | not deployed | not deployed |
| Sepolia | `0xd4e7134cd9fbcb1f48d9e2cc460f2afa40b621b8` | `0x05f70c867f2e4a26ed98e33b59895db09ed12f2c` |

The Sepolia deployment runs at 1/100 testnet scale (see `src/lib/Denominations.sol`), not the
mainnet ladder. Full addresses, ABI-relevant metadata, and fee/block info are in
`web/public/deployment.json`, the machine-readable record the site reads from.

---

Shapes is an independent primitive. It does not depend on any other protocol, and it makes
sense if nothing is ever built on top of it.

Wrapping ETH in a Shape is not an investment and earns nothing. The contract generates no yield
and makes no promises about what a Shape might be worth to anyone else. It guarantees one
thing: burn the token, receive the ETH.
