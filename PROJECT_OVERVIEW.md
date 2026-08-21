# Shapes — Project Overview

*A standalone description of the Shapes protocol, written for an outside reviewer. The goal
is unbiased feedback on the design: its coherence, its risks, and whether the pieces earn
their place. Nothing here is deployed — the contracts are pre-deployment, with no remote and
no tokens in existence anywhere.*

---

## 1. What Shapes is, in one sentence

Shapes is an ERC721 where each token wraps an exact amount of ETH: mint deposits ETH and gives
you a Shape; burn the Shape and you get back exactly the same wei. Everything else — the
generative artwork, the provenance system, the composition mechanics, the trait lottery — is
built on top of that single guarantee without ever weakening it.

The primitive is deliberately small. It does not lend, stake, invest, or seek yield on the ETH
it holds. It holds it. A Shape is not an investment and earns nothing; the only promise is
that burning the token returns its backing.

---

## 2. The backing model

### The nine denominations

Shapes does not accept arbitrary amounts. There are exactly nine, permanent, and every other
amount reverts:

```
0.01   0.05   0.1   0.5   1   5   10   50   100   ETH
```

(An earlier draft used `0.01 0.1 0.5 1 5 10 25 50 100`; the `25` was replaced by `0.05`
because the ×2.5 gap at 10→25 broke clean integer composition. The alternating ×5/×2
progression gives integer tier-to-tier ratios throughout.)

Backing is derived from a stored `denomIndex` (a `uint8`) against a fixed table. An off-ladder
wei amount is literally not representable in storage — there is no field that could hold it.

### The reserve invariant

The one invariant that must always hold:

```
address(this).balance >= redeemableBacking
```

In normal operation it is equality. It is stated as an inequality because Ethereum can force
ETH into any address through mechanisms outside `receive` (`selfdestruct`, block rewards,
pre-deployment funding). Any such surplus is permanently inaccessible — stranding a few stray
wei is treated as strictly better than opening any withdrawal path that could reach the
reserve. Direct ETH transfers to the contract revert; ETH enters only through `mint`.

The invariant is asserted as a stateful fuzz invariant over randomized sequences of minting,
transferring, redeeming, composing, decomposing, splitting, and sacrificing.

### ETH-out paths

There are exactly **three** code paths that move ETH out of the contract, and they are the
entire attack surface for solvency:

1. **Mint fee forward** — 1% of backing, forwarded to an immutable `feeRecipient` in the same
   transaction. Money received that same tx; never joins the reserve.
2. **Redemption payout** — reached only *after* the token is burned (checks-effects-interactions),
   `nonReentrant`, all-or-nothing.
3. **Sacrifice** — a fixed 100 ETH sent to `0x…dEaD`, gated to the owner of an apex
   token (see §5). Fixed amount, fixed unspendable destination.

No administrative function reaches any of the three.

### The mint fee

1% of the backing, charged on top of it, so `msg.value == backing + fee`. `feeBps` and
`feeRecipient` are `immutable`, fixed at deployment. Because 1% of every denomination is a
whole number of wei, the fee is exact at each — no rounding. Redemption is unaffected: a 1 ETH
Shape always redeems for exactly 1 ETH, fee already paid at mint. There is no burn fee, no
transfer fee, no royalty requirement, and no recurring protocol fee.

---

## 3. The artwork

### Value controls visual density

Higher value means *less*. The grid contracts as the denomination rises, so a Shape becomes
more concentrated and more monumental the more ETH it holds:

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
Nothing is added to compensate for the empty space.

### Seeds and the composition space

Value sets the grammar; an immutable `bytes32` seed, assigned at mint, writes the sentence.
The seed decides, per cell, which primitive lands there, whether it is solid or drawn, and its
rotation. The vocabulary is ten primitives — eight fillable forms (circle, square, triangle,
half circle, quarter circle, diamond, half square, right triangle) plus two open strokes (an
arc and a diagonal line) that are always outlined. Rotation-invariance and the outline-only
strokes yield 52 distinct module appearances.

Two card-level draws set a single size and a single stroke weight shared by every module, so a
card reads as one decision rather than a collection of them. Because size and stroke are
collection constants, the composition space is finite — enormous at dense denominations, but
exactly 2,704 at 50 ETH and **52 at 100 ETH**, where a card is a single module. A 100 ETH
Shape is one of fifty-two archetypes, and that is deliberate.

The seed determines artwork and nothing else. It has no economic effect: redemption value
comes from the denomination alone. Two Shapes of the same denomination are economically
equivalent at the redemption layer and remain distinct historical objects.

### Fully onchain, pure function

`tokenURI` returns a base64 `data:application/json` URI whose `image` field is a base64
`data:image/svg+xml` URI, both generated by `ShapeRenderer` at call time from the token's
stored state. No IPFS, no Arweave, no external images or APIs, no fonts, no server. The canvas
is a `0 0 250 350` viewBox (trading-card proportion), black background, white artwork, no other
colours, no gradients, no filters. A Shape carries no title, denomination, or number on its
face — just the marks; value and number live in the metadata.

### The parity strategy

There are two renderers: a canonical TypeScript implementation (the specification) and a
Solidity port (`ShapeRenderer.sol`). A generated fixture corpus is the contract between them,
and a parity test suite fails loudly if the two implementations disagree by so much as one
byte. All new rendering logic (provenance traits, ink genes, colour inversion) is ported in
lockstep and re-covered by parity fixtures. Every mark paints to exactly the same distance
from its cell centre, and each footprint is solved backwards from the target so a mark can
never overflow its cell and collide with a neighbour.

---

## 4. Provenance: origin conservation

This is the first layer built on top of the primitive, and it is the conceptual heart of the
collectible design. The problem it solves: how do you make "this Shape is assembled from many
independent mints" a *meaningful, unforgeable* property, using minimal on-chain state?

The answer is **one integer per token: `originCount`** — the number of independent direct-mint
events credited to this Shape.

- **Direct mint** → each new Shape gets `originCount = 1`.
- **Compose** (N→1) → `output.originCount = Σ inputs`.
- **Decompose** (1→k) → the parent's count is partitioned among children, each capped at its
  capacity (`childBacking / 0.01`), total conserved.

Origins are **conserved** under compose/decompose and **created only by minting new ETH**. The
global sum of all `originCount` equals (direct mints) − (origins redeemed); no operation
increases it except a fresh mint. This is what makes the count unforgeable: mint one 100 ETH
Shape (`originCount = 1`), decompose to 10,000 × 0.01, recompose — the count is still **1**,
never 10,000. You cannot manufacture origins.

### Complete

A token is **Complete** when its `originCount` equals its unit count (`units = backing / 0.01`),
with `units > 1`. It carries as many independent mint events as its backing has 0.01 units — a
live computed property, not a stored flag. Complete propagates upward: composing all-Complete
pieces yields a Complete, because both units and origin counts sum. Only the **100 ETH
Complete** (`originCount == 10,000`) can be sacrificed.

An honest subtlety the spec is careful about: an origin is one mint event *of any
denomination*, not a unit of 0.01 ETH. So Complete does **not** prove the backing entered as
all-0.01 mints — the decompose partition can concentrate credits onto smaller backing. The
design accepts this and argues it is economically irrelevant: the cheapest way to reach any
`originCount` is always the honest all-0.01 path, because origins scale with mint fees.
Fabricating density is strictly more expensive than earning it. (The earlier, stronger claim —
that Complete proves all-0.01 origins — was found invalid and explicitly removed.)

---

## 5. Composition mechanics

Four operations reshape tokens, modelled loosely on Checks (VV Edition) but adapted so identity
behaves asymmetrically. They form two pairs, one reversible and one not:

- **compose (many → one):** the caller names which input survives; it keeps its ID and seed and
  grows to the summed denomination, the others burn. Identity carries **up**. Backing only ever
  increases here, so there is no buyer-rug risk under a live listing.
- **decompose (the exact inverse of compose):** pops the survivor's most recent compose. The
  survivor keeps its ID and seed and reverts to the denomination, origin count and gene it held
  before that merge, and every input that compose burned is re-minted **under its original ID and
  seed** — not a fresh sequential one. Both the survivor's identity and each input's come back, so
  a composition can be fully unwound. Stacked composes reverse newest first. The record holding
  each input's state is stored per survivor, and `previewDecompose` reads it back, so a client
  never has to reconstruct it from event history.
- **split (one → many):** the input is fully burned; every output is a fresh sequential ID with a
  seed derived deterministically from the parent's (`keccak256(parentSeed, i)`). Identity **ends**,
  and so does the artwork — nothing reassembles it. Composing the pieces back yields a token
  carrying the survivor's own seed, not the split input's. A stale listing on the input auto-voids
  because the token is gone.
- **sacrifice (in place):** an apex 100 ETH Complete becomes a Black Shape — same ID, seed, and
  geometry, colours inverted (`#000↔#fff`). After: not redeemable, not recomposable, `backingOf`
  is 0, and `sacrificedBacking` permanently reports 100 ETH. The 100 ETH is sent to `0x…dEaD` as a
  real, visible, independently-verifiable economic burn. Black Shapes stay transferable ERC721s
  (not soulbound). Identity is terminal.

An earlier design had a fifth operation, `restore`, which reassembled a split's complete child set
back into the original artwork. It was removed. A split is now final, which is both simpler and
more honest: the reason given for a split ending identity sat awkwardly beside an exception that
un-ended it.

Recomposition moves **no ETH** and conserves backing by an explicit equality check, so it cannot
affect solvency. Compose makes no external calls at all; split and decompose do all accounting
before any `_safeMint`, so receiver callbacks are safe.

Deterministic child seeds are a deliberate choice: they fix the entire split tree of every token at
mint. Owners navigate a possibility space set at mint rather than rolling per-block entropy, and a
frontend can preview any split exactly before executing. Since seeds have no economic effect,
mint-time seed grinding (about one attempt per block) is an accepted, priced risk rather than a
vulnerability.

### One marketplace caveat, documented

The only remaining mutation-rug vector is sacrifice: a standing collection- or trait-level WETH
bid on an apex Complete can be filled with a Black Shape if the owner sacrifices it and then
accepts the bid. ERC-4906 `MetadataUpdate` speeds refresh of the token's own listing but does not
cancel standing offers. Any integrator that values a token by `backingOf` must treat an
owner-held apex Complete as mutable to zero. This is disclosed rather than fixed.

### Provenance lives in events

Ancestry is not stored on-chain (a Complete can swallow up to 10,000 tokens; storing the tree is
infeasible). Each operation emits an explicit lineage event (`Composed`, `Decomposed`, `Split`,
`Blackened`, plus `ShapeRedeemed` carrying `originCount`), and full ancestor trees are
reconstructed off-chain. The exception is the compose record itself, which *is* stored, because
`decompose` needs it to revive each input exactly.

IDs are issued from 0, and `totalMinted` counts IDs issued rather than naming the highest one, so
the highest issued is `totalMinted - 1`. `decompose` reuses IDs rather than issuing them and does
not advance the counter, which is what keeps a revived ID below every fresh one. Fee-free
recomposition inflates neither ETH nor origins.

---

## 6. Ink genes: a trait that travels by odds

The most recent layer, fully implemented in the contract. It adds one `uint8 inkGene` per token
(seven states: Void, Faint, Sparse, Murk, Dense, Rich, Solid) that controls how solid the
card renders — replacing the seed's card-level fill draw. The design principles:

1. **Entropy enters once, at mint.** Nothing downstream rolls dice; every outcome is a pure
   function of the participating seeds, previewable on-chain via `simulateCompose` before you
   commit.
2. **Each attempt consumes something real.** Composed-away seeds die forever; new entropy costs
   mint fees. Gas alone never buys a reroll.
3. **Rare traits travel through lineage by odds, not by perfection of every input.**

**At mint:** the gene is a pure function of the seed. Dust (0.01) mints roll the full lottery —
a pyramid peaked at Murk, with the extremes (Void, Faint, Rich, Solid) reachable *only* here.
All higher direct mints roll a narrow band (Sparse/Murk/Dense only). So a direct 100 can never
mint Solid; the summits are lineage-only, which caps mint-redeem reroll shopping at scale.

**On compose:** the survivor's gene walks toward the pool. The randomizer XOR-folds the burned
seeds (so `burnIds` order cannot become a free reroll knob) and keys off the survivor's seed
(survivor choice *is* a real strategic trade-off, in the spirit of Checks' "Burner's Choice").
For each tier crossed, one roll: 70% step toward the units-weighted mean, 20% toward the best
gene present, 10% toward the worst. A single dust card can carry a Solid gene into a huge
composition at bounded odds — that asymmetry is the game. Homogeneous pools are deterministic
(pure in, pure out — no attrition tax on honest purity), and a tier-jumping mega-compose faces
exactly the same number of rolls a step-by-step climb does, so jumping tiers saves gas, never
risk.

**On split and decompose:** split children inherit the parent's gene unchanged; decompose takes the
children's common gene. No new storage, no reroll machine — decompose→recompose of a token's
own children returns the same gene with certainty.

The intended texture: the endgame difficulty of chasing a rare gene is measured in
*temporarily-parked, fully-redeemable ETH* and off-chain combinatorial legwork (searching
pairings, since outcomes are deterministic per candidate set), not in burned money. For a
wrapper protocol, "the endgame is parking more ETH" is argued to be the right kind of
difficulty.

---

## 7. Immutability, admin surface, and title

Administrative power is narrow and value-inert. The owner may replace the renderer and the
collection metadata contract, freezing both together with `lockRenderer`; may set and separately
lock an optional position resolver; and may edit the metadata copy — the token name prefix, the
descriptions, the collection name — which is validated on write to close a JSON-injection channel.
Every one of these is read only by metadata views. None can change what a Shape is worth, whether
it redeems, or who owns it. The owner may renounce ownership at any time.

`feeBps` and `feeRecipient` are `immutable`. The reserve, denominations, and redemption path have
no admin access at all. Deliberately absent: emergency withdrawal, treasury withdrawal, redemption
pause, asset recovery, backing modification, token seizure, admin burn, fee change, upgradeability,
proxies, allowlists, supply caps, royalties.

One deliberate refusal: a Shape cannot be minted or transferred to the `Shapes` contract itself,
since the contract can never be `msg.sender` and such a token could never be redeemed.

### Contract title

Separately, and carrying no authority whatsoever, the contract records a title holder:
`titleHolder`, `titleSince`, `transferTitle`. This is cultural title to Shapes as a whole,
recorded by the work itself rather than by a certificate.

It is not a token. No title NFT, no companion collection, no reserved Shape; `Shapes.titleHolder()`
is the only record, so nothing competes with it. Its holder cannot reach the reserve, the fees, any
Shape, the renderer, the collection, the resolver or `owner()`, and gains no intellectual property
or legal right. `msg.sender == titleHolder` appears in exactly one function, `transferTitle`.

Title and administrative ownership are independent in both directions. Ownership can be renounced
with the title still transferable, which is the point of recording it here: the title is meant to
outlive administration. Transfer is a bearer transfer — immediate, one transaction, no approval, no
acceptance by the recipient, and no recovery. Title sent somewhere that cannot move it again is
stranded permanently, deliberately, because an owner able to recover it would be an owner able to
take it.

A sale needs nothing from the contract: the holder settles payment however they like and calls
`transferTitle`. An auction is the same shape, with an auction contract holding title between
seller and winner.

---

## 7a. Two satellite contracts

Neither holds a privileged position over `Shapes`, and `Shapes` knows nothing about either.

**`ShapeCollection`** serves contract-level metadata and seeded card previews. It reads
`block.prevrandao`, so the collection image changes each block: an animated filmstrip of one frame
per denomination, cycling down the ladder. It is the one piece of presentation that is not a pure
function, and it drives nothing economic.

**`ShapeAuctionHouse`** is an English auction where a bid is a *set of Shapes* whose summed backing
is the bid amount. A bidder holding no Shapes can bid ETH and the house mints the minimal card set
for that amount, so every bid ends up expressed as cards either way. Amounts are carried in 0.01
ETH units, which is exactly the granularity the denomination ladder can express.

The lot is any ERC721; only the bid is denominated in Shapes. That is possible because nothing is
ever pushed, including the lot. `settle` and `cancelAuction` record an outcome and transfer
nothing, and the lot leaves through `claimLot`, pulled by the winner or by the seller when the
auction closed unsold. So a lot that refuses to move blocks its own delivery and nothing else: the
seller still claims the winning cards and every outbid bidder still withdraws, because those paths
move Shapes alone. An earlier revision restricted the lot to Shapes after an audit found that a
lot could block settlement and strand the leader's escrow; that was a property of the house pushing
the lot rather than of the lot being unknown, and the pull removes it at the source.

Escrowed cards are pulled for a related reason: pushing up to sixty-four ERC721 transfers inside a
bid would shift that cost onto whoever outbids.

What the house cannot do is tell an honest collection from one that reports its own state falsely.
A contract lying about `transferFrom` lies about `ownerOf` too, so a seller can list a lot that
will never be delivered and take a real bid for it. There is no on-chain fix; the bound is that
the lot's address is reached from `createAuction` and `claimLot` alone, so the loss falls on the
bidder who chose that auction. `createAuction` does check ERC165 for the ERC721 interface and that
the caller owns or is approved for the token, which rejects a wrong address and an unauthorised
lister — the mistakes that actually happen — and a (collection, token) index refuses a duplicate
listing. The house takes no fee and has no owner.

## 8. Testing and repository

```
src/
  Shapes.sol            ERC721 + reserve + composition + sacrifice + ink genes + title
  ShapeRenderer.sol     fully onchain SVG and metadata
  interfaces/           IShapes, IShapeRenderer
  lib/
    Denominations.sol   the nine amounts and their grids
    FixedPoint.sol      WAD arithmetic + canonical decimal formatter
    Round03Rand.sol     the deterministic random stream
    InkGenes.sol        pure gene library (mint lottery + compose walk)
test/
  Shapes.t.sol          minting, fees, redemption, reserve security
  ShapeRenderer.t.sol   stream, formatter, geometry, metadata validity
  Parity.t.sol          byte-identical output vs the TypeScript fixtures
  Hardening.t.sol       regressions for adversarial-review findings
  Invariants.t.sol      stateful solvency + conservation invariants
  Fork.t.sol            full lifecycle against a mainnet fork (env-gated)
preview/                generative preview harness + chain tester (TypeScript)
```

The invariant suite asserts, over fuzzed operation sequences: solvency
(`balance >= redeemableBacking`), backing conservation across compose/decompose, origin
conservation (`Σ live originCount == mint-origins − redeemed-origins`), per-token and global
capacity bounds, and sacrifice accounting (`sacrificedBacking == 100 ETH × blackCount`). The
mainnet-fork test drives the full lifecycle under a real block environment (chain id 1,
post-merge `prevrandao`, real prior blockhash and timestamp — all of which feed the mint seed).

The `preview/` harness renders the full nine-denomination ladder, generates reproducible
batches, exposes every design parameter as a live control (marking which values Solidity
actually commits to), detects exact geometry collisions, and can export animated GIFs with a
hand-written encoder. It also hosts a chain tester that talks to a locally-deployed contract,
reads artwork back from the chain's own `tokenURI`, and shows the reserve invariant live.

---

## 9. Current status

Pre-deployment. No mainnet or testnet deployment of the current line, no tokens anywhere — so
interface-breaking changes are still free and no migration is required.

Two external security audits have run against the auction layer and the token core. Both High
findings were in the auction house. One, that a lot could block settlement and strand the leader's
escrow, is closed at the source: settlement no longer touches the lot, so nothing about the lot can
prevent an outcome, a payout or a withdrawal. The other, that a lot contract could fake delivery
and take a real winning bid, has no on-chain fix and is documented as bounded rather than closed —
see §7a.

The Low findings are closed except one, which is accepted: a Shape pushed into the house by a plain
`transferFrom` is held with no escrow entry. A per-owner house could offer a recovery function, as
`SovereignAuctionHouse` in `ripe0x/pin` does, but this is a single permissionless house holding
every bidder's escrow, so it has no owner to entrust with that power and inventing one would be an
administrative path into other people's cards.

The documentation gap this section used to flag has been closed, and `script/check-docs.sh` now
fails if any document names a selector the compiled contract does not have.

The live constraint is contract size. `Shapes` is within roughly a kilobyte of the 24,576-byte
limit, so anything further needs measuring before it is written, and the next addition should come
with a decision about what comes out.

Known outstanding before deploy: nothing reserves token 0 beyond minting it in the same broadcast
as the deployment, so a live deployment that cares should go through a private mempool; and the
web deployment record still points at a superseded testnet deployment.

## 10. Design philosophy — what the reviewer should weigh

The through-line is a strict priority order, stated by the product owner:

1. **Trustworthiness of the ETH backing and redemption system** — never compromised by any
   feature above it.
2. **Composition and provenance as a genuinely meaningful collectible system.**
3. **Keeping the primitive simple enough for other contracts to build on.**

Every layer is designed to sit *on top of* the backing guarantee without touching it: provenance
is one conserved integer, composition moves no ETH and conserves backing by explicit equality,
and the ink-gene game injects entropy only at mint and otherwise runs as pure deterministic
functions. Shapes is meant to be an independent primitive that "makes sense if nothing is ever
built on top of it."

That last clause is also an invitation. Because a Shape is a plain ERC721 wrapping a known,
redeemable amount of ETH, with unforgeable provenance and a previewable trait system, it is a
clean building block for other contracts — collateral, gift/escrow flows, curation and
display, games, or randomized-reward machines (for instance an `fwa.fun`-style gacha could use
Shapes as its prize tokens). That is one of many possible external uses, not a design driver:
none of the mechanics above are built *for* any such integration, and the protocol should be
judged on its own terms first. It is called out only so the reviewer knows the primitive is
intended to be composable, not siloed.

---

## 11. Specific questions for a reviewer

1. **Backing safety.** Is there any compose / decompose / split / sacrifice sequence that could
   violate `balance >= redeemableBacking`, or that increases the global `originCount`? The
   claim is no; the invariants assert it — is the reasoning airtight?
2. **Provenance model.** Is "one conserved integer + events" the right minimal representation,
   or does the origin-concentration subtlety (§4) undermine "Complete" as a collectible signal
   in practice, even if it is economically irrational to exploit?
3. **Ink-gene tuning and fairness.** The mint distributions and the 70/20/10 walk are tunable
   constants, frozen at deploy. Given previewable outcomes and free off-chain pairing search,
   are the published odds honest, and is "difficulty = parked ETH + combinatorial legwork" a
   sound framing?
4. **The sacrifice marketplace caveat (§5).** Is documenting the standing-bid mutation risk
   sufficient, or does it warrant a mechanism-level fix?
5. **Simplicity vs. surface.** Three layers now sit on the primitive. Does the composition +
   ink-gene surface still leave something "simple enough for other contracts to build on," or
   has the primitive grown past that goal?
6. **Anything mispriced as "accepted risk"** — particularly mint-time seed/gene grinding
   (one attempt per block) and the deliberately inaccessible forced-ETH surplus.
