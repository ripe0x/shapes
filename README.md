# Shapes

ETH in, Shape out. Shape burned, the same ETH out.

A Shape is an ERC721 token that wraps an exact amount of ETH. Whoever owns the token owns the
right to unwrap it. Burn the token and you receive exactly the ETH it held — not a share of a
pool, not a proportion, not a claim. The same wei.

Between minting and burning, a Shape is an ordinary NFT. Transfer it, sell it, deposit it in
another contract, hold it. The artwork and the token's history make it a distinct object; the
denomination makes it exactly as redeemable as every other Shape of that size.

The contract does not lend the ETH, stake it, invest it, seek yield on it, or use it for
anything. It holds it.

---

## The nine denominations

Shapes does not accept arbitrary amounts. There are exactly nine, and they are permanent:

```
0.01   0.1   0.5   1   5   10   25   50   100   ETH
```

Every other amount is rejected. 100 ETH is the maximum.

## Value controls visual density

Higher value means less. The grid contracts as the denomination rises, so a Shape becomes more
concentrated and more monumental the more ETH it holds:

| ETH | Grid | Modules |
|---|---|---|
| 0.01 | 5 × 5 | 25 |
| 0.1 | 4 × 5 | 20 |
| 0.5 | 4 × 4 | 16 |
| 1 | 3 × 4 | 12 |
| 5 | 3 × 3 | 9 |
| 10 | 2 × 3 | 6 |
| 25 | 2 × 2 | 4 |
| 50 | 1 × 2 | 2 |
| 100 | 1 × 1 | 1 |

0.01 ETH is maximum complexity. 100 ETH is irreducible: one module, alone on a black field.
Nothing is added to compensate for the space.

## How seeds create unique compositions

Value sets the grammar; the seed writes the sentence. Each token receives an immutable
`bytes32` seed at mint. The seed decides, for every cell in the grid, which primitive lands
there — circle, square, triangle, half circle, quarter circle or diamond — whether it is solid
or drawn, and how it is rotated. That is 30 distinct module appearances. Two card-level draws set a single size and a single stroke weight shared by every
module on that token, so a card reads as one decision rather than a collection of them.

How solid a card is, is drawn per card rather than fixed: about 5% of Shapes come out entirely
outlined, about 5% entirely solid, and the rest land somewhere between. Both extremes are exact
— an all-solid Shape contains no drawn mark at all — and are surfaced as a `Fill` trait.

Because size and stroke are collection constants, the composition space is finite: enormous at
the dense denominations, but exactly 900 at 50 ETH and **30 at 100 ETH**, where a card is a
single module. A 100 ETH Shape is one of thirty archetypes, and that is deliberate — see
SPEC.md D15. Each Shape remains a distinct object regardless: unique token number, unique seed,
its own provenance.

Every mark on a card paints to exactly the same distance from its cell centre — the same for
each primitive, solid or outlined, stroke and miter joins included. Each footprint is solved
backwards from that target rather than measured after the fact, so a mark can never overflow
its cell and collide with its neighbour. See SPEC.md D13.

The seed determines artwork and nothing else. It has no economic effect: redemption value comes
from the denomination alone, so every 1 ETH Shape redeems for exactly 1 ETH regardless of what
it looks like.

Two Shapes of the same denomination are economically equivalent at the redemption layer and
remain distinct historical objects. That is the whole design.

---

## Minting

Minting is permissionless.

```solidity
mint(uint256 amountWei, address to) payable returns (uint256 tokenId)
mintBatch(uint256 amountWei, uint256 quantity, address to) payable returns (uint256 firstTokenId)
```

You send the backing **plus a fixed fee per NFT**:

```
mint a 1 ETH Shape   ->  msg.value = 1 ETH + mintFee
                         the NFT's redemption value = exactly 1 ETH

ten 1 ETH Shapes     ->  msg.value = 10 ETH + 10 x mintFee
                         backing obligation = exactly 10 ETH
```

The value must be exact — over and under both revert. Each token in a batch gets its own id and
its own seed.

## The fixed mint fee

Shapes charges a small flat fee per NFT minted. Not a percentage. A 100 ETH Shape does not cost
ten thousand times more to mint than a 0.01 ETH Shape merely because it holds more ETH.

`mintFee` and `feeRecipient` are `immutable`, chosen at deployment. Fees are forwarded to the
recipient in the same transaction and never join the reserve. The example deployment uses
0.0005 ETH; that is a deploy-time parameter, not a source constant.

There is no burn fee, no transfer fee, no royalty requirement, and no recurring protocol fee.

## Transfers

A Shape is a normal ERC721. Transfer and approval work as expected. Redemption rights follow the
token: the current owner can always unwrap it, and a previous owner cannot.

One deliberate refusal: a Shape cannot be minted or transferred to the `Shapes` contract itself.
The contract can never be `msg.sender`, so such a token could never be redeemed.

## Redemption

```solidity
redeem(uint256 tokenId)
redeemBatch(uint256[] calldata tokenIds) returns (uint256 totalWei)
```

The current owner burns the token and receives its exact backing, paid directly to them. All or
nothing — there is no partial redemption, and no way to add ETH to an existing Shape. A 1 ETH
Shape is a 1 ETH Shape for its entire lifetime.

`redeemBatch` burns each token, then makes a single transfer of the exact total.

If the ETH transfer fails, the entire redemption reverts. The token survives and the backing
stays put.

---

## The reserve

The invariant, always:

```
address(this).balance >= totalBacking()
```

In normal operation it is equality. It is stated as an inequality because Ethereum can force
ETH into any address through mechanisms outside `receive` — `selfdestruct`, block rewards,
pre-deployment funding. Any such surplus is permanently inaccessible. That is the intended
outcome: stranding a few stray wei is strictly better than opening a withdrawal path that could
reach the reserve.

Direct ETH transfers to the contract revert. ETH arrives only through `mint`.

Every wei counted by `totalBacking()` corresponds to a live Shape, and is asserted as a
stateful invariant over fuzzed sequences of minting, transferring and redeeming.

## Immutability

There is no owner. `Ownable` is not inherited and no administrative role exists.

Deliberately absent: emergency withdrawal, treasury withdrawal, redemption pause, asset
recovery, backing modification, token seizure, admin burn, metadata replacement, renderer
replacement, upgradeability, proxies, allowlists, supply caps, royalties.

`mintFee`, `feeRecipient` and `renderer` are `immutable` and have no setters. There are exactly
two code paths that move ETH out of the contract: the fee forward during minting, and the payout
during redemption — and the latter burns the token first.

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

Nothing the renderer reads is mutable, so a token's artwork is fixed at mint and cannot change.

---

## Repository

```
src/
  Shapes.sol                  ERC721 + the reserve
  ShapeRenderer.sol           fully onchain SVG and metadata
  interfaces/
    IShapes.sol
    IShapeRenderer.sol
  lib/
    Denominations.sol         the nine amounts and their grids
    FixedPoint.sol            WAD arithmetic + the canonical decimal formatter
    Round03Rand.sol           the deterministic random stream
script/
  DeployShapes.s.sol
  e2e-anvil.sh                live end-to-end check against a local chain
  fork-dev.sh                 forked Anvil + deploy, for the chain tester
test/
  Shapes.t.sol                minting, fees, redemption, reserve security
  ShapeRenderer.t.sol         stream, formatter, geometry, metadata validity
  Parity.t.sol                byte-identical output vs the TypeScript fixtures
  Hardening.t.sol             regressions for the adversarial review findings
  Invariants.t.sol            stateful solvency invariants
  Fork.t.sol                  full lifecycle against a mainnet fork (env-gated)
  fixtures/fixtures.json      generated corpus, do not hand-edit
preview/                      the generative preview harness + chain tester
SPEC.md                       implementation plan and every rendering decision
SECURITY.md                   adversarial review
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
delegation. The suite treats the former as stranded surplus (`balance >= totalBacking` still
holds) and mints only to codeless recipients, matching how the contract behaves in the wild.

## Running the preview harness

```bash
cd preview
npm install
npm run dev            # http://localhost:5173
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
npm run fixtures       # writes test/fixtures/fixtures.json
cd .. && forge test --mc Parity
```

Regenerate whenever the canonical renderer changes, and expect the parity suite to fail loudly
if the two implementations disagree by so much as one byte.

## Chain tester

A second preview entry talks to a deployed contract instead of the canonical renderer: deposit
ETH, read the resulting artwork back from the chain's own `tokenURI`, and redeem. It is a
development harness, not the launch surface — Shapes ships contracts-only — but it exercises the
real deposit and withdraw paths and renders the actual onchain SVG rather than the TypeScript
one.

```bash
./script/fork-dev.sh                          # forked Anvil + deploy, writes the address
cd preview && npm run dev                      # in another shell
open http://localhost:5173/chain.html
```

`fork-dev.sh` boots a mainnet-forked Anvil, deploys through the real deploy script, and writes
the deployed address to `preview/public/deployment.json`, which the page reads on load. It signs
with a local test key, so no wallet extension is involved; on load it strips any inherited
EIP-7702 delegation from that account and funds it, so `_safeMint` treats it as an EOA. The page
shows the reserve invariant live — contract balance against `totalBacking()` — alongside every
Shape the account holds.

## Deploying locally

```bash
anvil                                        # in one shell

forge script script/DeployShapes.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast

./script/e2e-anvil.sh                        # mint all nine, transfer, redeem, verify
```

For a live deployment, both parameters are permanent, so set them explicitly:

```bash
SHAPES_MINT_FEE=500000000000000 \
SHAPES_FEE_RECIPIENT=0x... \
forge script script/DeployShapes.s.sol --rpc-url $RPC          # dry run first
```

The script refuses to proceed off a local chain without an explicit fee recipient, rejects a
contract fee recipient unless you confirm it, smoke-tests the renderer, and asserts every
immutable landed as intended before reporting success.

## Deployed addresses

| Network | Shapes | ShapeRenderer |
|---|---|---|
| Mainnet | not deployed | not deployed |
| Sepolia | not deployed | not deployed |

---

Shapes is an independent primitive. It does not depend on any other protocol, and it makes
sense if nothing is ever built on top of it.

Wrapping ETH in a Shape is not an investment and earns nothing. The contract generates no yield
and makes no promises about what a Shape might be worth to anyone else. It guarantees one
thing: burn the token, receive the ETH.
