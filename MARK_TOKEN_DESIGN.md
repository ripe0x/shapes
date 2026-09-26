# $MARK: A Speculative Game Layer on Shapes

Status: design exploration, not a spec. `$MARK` is a placeholder name.

The idea in one line: **your chips are always worth exactly what they say, and the only thing
that moves is $MARK.** Shapes hold capital at exact par, so all of the volatility sits in the
token. This design aims for volatility. It does not try to damp it.

---

## 0. Protocol facts this design depends on (verified in this repo)

These go beyond the brief. Every mechanism below is built on them.

| Fact | Source | Why it matters |
|---|---|---|
| Every module at 5 ETH and above is one of the **same 52 archetypes**. 100 ETH = 1 module (52), 50 ETH = 2 (52² = 2,704), 10 ETH = 4 (52⁴ ≈ 7.3M), 5 ETH = 6 (52⁶ ≈ 1.9e10) | `SPEC.md` sampling table; `moduleAt(id, i)` returns `(kind, solid, rotation, …)` | **A Shape is a hand of cards drawn from a 52-card deck.** The spec's own word for it is "a suit". A 50 ETH card has two hole cards, like Texas Hold'em. A 10 ETH card has four, like Omaha. |
| Mint seeds come from `prevrandao`, the previous blockhash and `tokenId` | `Shapes.sol` `_batchRoot` | In one transaction a contract can run mint → inspect → redeem → mint again. **A re-roll costs one mint fee plus gas.** A specific 100 ETH archetype costs about 52 × 0.001 ≈ 0.05 ETH in fees (with flash liquidity). **Archetype rarity is not scarce, and no mechanism should price it as scarce.** |
| Compose, split and decompose use **no fresh entropy**. `previewCompose`/`previewSplit` return the exact result | `INK_GENES_IMPL_SPEC.md`, `ModulesSampled` | Minting is a gamble; compose is crafting. Players can search over input sets to build a target gene or hand. |
| The ink gene sets the solid/outline probability per module, and `solid` is part of the archetype | `InkGenes`, `moduleAt` | The ink gene shapes which archetypes a card can show. It can be wired to suits. |
| Non-dust mints only roll Sparse, Murk or Dense. Void and Solid come only from dust (3% each) or from compose walks | `INK_GENES_IMPL_SPEC.md` §1 | Extreme-gene high-denomination cards must be crafted, which creates a real market for Void and Solid dust. |
| **Complete** means `originCount == units`. A Complete 100 ETH card needs **10,000 separate origins**: at least 10 ETH in mint fees and about 3,333 composes | `ShapeMath`, `SPEC.md` §compose gas | A Black Shape costs about **111 to 135 ETH** all-in and takes visible days to build. That buildup is watchable onchain. |
| The admin can adjust `mintFee` up to `unit()` (0.01 ETH) and redirect the fee recipient | `IShapes` | Any mechanism that uses "fee paid" as work must survive the fee changing. |
| `positions` pointer / `positionOf(tokenId)` | `IShapePositionResolver` | A game contract can attach "seated at table X" to a card's canonical view without taking custody. |

---

## 1. First principles: what keeps a speculative system in attention indefinitely

1. **Nested clocks.** One timescale gets boring and no timescale gets forgotten. You need a fast
   tick (hourly), an appointment (daily, at a fixed time people plan around) and an
   irregular big event whose timing nobody controls. Bitcoin has blocks, difficulty epochs and
   halvings. Lotteries have draw nights and rollovers.
2. **A visible threshold that moves.** Tension comes from a line on a chart that is approaching
   something. "Price crossed X, so Y becomes profitable for someone" writes its own content.
3. **Legible rivals.** People fight people, not curves. Public hands, named seats, factions and
   leaderboards. Full information is fine: televised poker with hole cams is more watchable than
   blind poker.
4. **Computable but uncertain EV.** Degens want to run the numbers and still lose sometimes. Known
   odds with an unknown outcome.
5. **Every state change is an image.** Shapes render onchain SVG. Every draw, hand, eclipse and
   crafted card is already a post.
6. **No terminal state.** Emissions only bootstrap the system. The engine that lasts is
   player-versus-player flow with a rake, and eras that reset the leaderboards.
7. **At least two reflexive loops pointing opposite ways.** Price → mining rate → sell pressure
   works against price → eclipse probability → halving → scarcity. Their interaction is where the
   narrative comes from.
8. **Forced two-sided flow.** Volume needs structural sellers (miners) and structural buyers
   (antes and bets). If one side is missing, the chart goes flat.

What Shapes adds that no memecoin has: **the capital at the table never moves.** A 50 ETH seat is
50 ETH before and after the hand. All of the risk is pushed into $MARK. Call it principal-safe
degeneracy: the table is ETH at par and the chips are $MARK.

---

## 2. Five mechanisms

### M1. The Rig: proof-of-fee mining

**What happens.** You mint any Shape through the Rig contract. The Rig forwards backing plus
`mintFee` to Shapes and delivers the card to you. It also sends a fixed **rig burn of 0.002 ETH per
card to `0xdead`**. Each mint earns one share of the current hourly emission block. Shares are
credited pro rata within the hour, and you can redeem the card straight away.

- Cost per share for the public: 0.001 fee + 0.002 burn + gas ≈ **0.003 ETH**. Capital is fully
  recoverable at par.
- Hourly block (era 0): 25,000 $MARK.
- Break-even price: `p* = N_mints_per_hour × 0.003 / 25,000`.

| Mints / hour | p* (ETH per $MARK) | ETH per day to artist | ETH per day burned |
|---|---|---|---|
| 100 | 1.2e-5 | 2.4 | 4.8 |
| 1,000 | 1.2e-4 | 24 | 48 |
| 5,000 | 6.0e-4 | 120 | 240 |

**Why a degen cares.** It's Bitcoin mining where the rig costs nothing and the electricity is a
0.003 ETH ticket. Hashprice charts, difficulty, "am I above water this hour". The first hour of
launch has almost no hashrate, so the cheapest cost basis goes to whoever shows up first.
Re-rolls for other games (M3) also go through the Rig, so **grinding is mining.**

**Primitive.** Exact par: minting is free apart from the fee, so the only real cost is the fee and
burn. Permissionless mint. Each mint creates one origin, the raw material for Completeness.

**Failure modes.**
- *Artist edge.* The 0.001 fee returns to the fee recipient, so the artist's cost is 0.002 per
  share against 0.003 for everyone else, a 1.5× hashrate edge. The rig burn exists only to shrink
  this edge; with no burn the artist mines at gas cost. Either disclose the edge or point
  `feeRecipient` at M4's Furnace during mining.
- *Fee changes.* Shares count mints, and the burn is fixed. If the admin sets `mintFee` to 0,
  mining still costs 0.002 per share. If it goes to 0.01, mining costs 0.012 per share and
  hashrate drops. Either way the system still works.
- Miners are structural sellers. See §5.

### M2. Eclipse eras: the Black Shape as a halving

**What happens.** Daily emission is `E_n = 1,000,000 × 2^-n $MARK`, where
`n = blackShapeCount() − blackShapeCount_at_launch`. Anyone's `burnBacking` counts, so the protocol
reads it and needs no permission. 15% of each day's emission accrues to an **Eclipse Bounty**. The
bounty pays out in full to whoever holds the Black Shape at the moment it's created (the contract
checks the count increment and `isBlackShape`). Then the bounty resets and a new era begins.

- Eclipse cost: 100 ETH burned + 10,000 origins (10 ETH in plain fees, or 30 ETH through the Rig,
  which also earns 10,000 shares) + about 1 to 5 ETH of gas across roughly 3,333 composes.
  Call it **~115 ETH**.
- **The Eclipse Line** is a public, descending trigger price: `L(t) = 115 ETH / Bounty(t)`.

| Days into era 0 | Bounty | Eclipse Line (ETH per $MARK) |
|---|---|---|
| 7 | 1.05M | 1.1e-4 |
| 30 | 4.5M | 2.6e-5 |
| 60 | 9.0M | 1.3e-5 |

  When the market price crosses above the line, eclipsing is profitable before you even count the
  halving's effect on the eclipser's own bag. In practice the real trigger comes sooner, because
  large holders also profit from the halving.

**Why a degen cares.** A halving with no scheduled date. It's triggered by a sacrifice, and it gets
more likely every day. A public race: Complete 10s and 50s are visible onchain, so "someone is
holding a Complete 50" becomes an eclipse watch. Miners want it delayed and holders want it now.
The Black Shape it produces is the most expensive object in the collection, and the contract
counts it forever.

**Primitive.** `burnBacking`, `blackShapeCount`, the Complete provenance cost and the ladder's
compose path, which makes the buildup slow and visible.

**Failure modes.** If price never reaches the line, the halving story dies quietly. A whale can
eclipse early and crash miner economics. Eras that are too long, or too short, both lose
attention. Pre-assembled Complete stock left over from before launch lets insiders front-run the
first era, so publish the starting Complete census at launch.

### M3. Hole Cards: every Shape is a poker hand

**What happens.** Publish a fixed bijection from the 52 archetypes to a standard deck. Build the
suits from `solid` plus one geometric bit, so **ink gene affects flush odds**: a Void or Solid card
can only show half the suits. A card's modules are its hole cards. The denomination sets the game:

| Denomination | Hole cards | Table |
|---|---|---|
| 50 ETH | 2 | **Hold'em** (launch) |
| 10 ETH | 4 | Omaha (must play exactly 2) |
| 5 ETH | 6 | Six-card Omaha |
| 100 ETH | 1 | The Ace table: direct-hit, 52-number roulette with rollovers |

The board is drawn with replacement, so five of a kind exists and ranks above a straight flush.
There is one Deal per day with three reveals, so three appointments:

- **23:00 UTC** seat cutoff. Seats are non-custodial: register a `tokenId` and pay an ante. At
  showdown the contract checks that `ownerOf` and the hash of `effectiveModulesOf` are unchanged.
  No Shape is ever escrowed, so there's no honeypot.
- **00:00** flop (3 cards), **08:00** turn, **16:00** river. Randomness is VRF or a committed
  future-block RANDAO. A bare `prevrandao` is biasable.
- **16:00 to 20:00** showdown window. Seats *show* by calling `showdown(seat)`, which runs the
  7-card eval onchain. The best hand at window close wins, and ties split. A seat that doesn't
  show forfeits.

Money flows:
- **Seat pot** = 25% of daily emission + seat antes (1,000 $MARK per seat per Deal, 10% burned).
- **The Floor** is for everyone without 50 ETH: a parimutuel $MARK market on *which seat wins*, with
  a separate pool per street (pre-flop, flop, turn) so late information doesn't dilute early
  bettors. 5% rake: 3% burned, 2% to the seats that were backed. Seats want backers, so seat owners
  shill their own hands.

Because hole cards are public, the Floor is a live equity-versus-odds market. Quants arbitrage
parimutuel odds against computed equity all day.

**Why a degen cares.** It's televised poker with hole cams, played with ETH-backed cards. You can
buy your hand: re-rolling a 50 ETH card for any pocket pair of top rank costs about 16/2,704 odds,
roughly 170 mints or 0.5 ETH through the Rig. You can also *craft* it through `previewCompose`
search. Secondary Shapes gain a hand premium capped at re-roll cost, which is a clean arb band for
NFT traders.

**Primitive.** 52 archetypes with 50 ETH = 52², exact par (the seat is risk-free), ink gene → fill →
suit, deterministic compose, and a mint entropy that is re-rollable.

**Failure modes.**
- *Grinding flattens hands.* The meta converges on premium hands, so split pots are frequent and
  the board decides everything. That's acceptable, because it's still a lottery with visible
  crowding, but the skill layer thins out.
- *Onchain 7-card eval gas.* Plan for 150k to 300k gas per showdown.
- *Minimum 50 ETH to sit.* Retail lives on the Floor until the smaller tables open.
- *The artist may reject card faces on their archetypes.* See §5.

### M4. The Furnace: card-denominated issuance that can only end in an eclipse

**What happens.** $MARK lots are sold in auctions whose **bids are Shape cards**, following the
auction-house pattern the collection already uses. Only Complete cards are accepted (single-origin
dust or any Complete composite). Losing bids are returned. Winning cards go into the Furnace, a
contract whose **only** capabilities are `compose` and `burnBacking`. When its Complete stock
reaches 100 ETH, it assembles the apex and eclipses it.

**The bid that tips the Furnace over 100 wins the Black Shape**, which triggers M2 and the bounty.

**Why a degen cares.** Every $MARK issued this way is ETH sent into the sun. The Furnace gauge
("63.4 / 100") is a FOMO3D-style last-mover race for the most expensive object in the collection.
Higher $MARK prices bring bigger bids, which mean faster eclipses, faster halvings and more
scarcity. That's the second reflexive loop.

**Primitive.** Card-denominated auctions, Complete provenance (Complete + Complete stays Complete),
and `burnBacking`.

**Failure modes.** A partly filled Furnace holds up to about 99.99 ETH in cards, which looks like a
treasury even though nothing in it can ever be redeemed. The code has to show that no path out
exists. Ladder constraints mean odd-sized bids sit uncomposed. The last-mover race invites griefing
and sniping in the final block.

### M5. Ink Tide: a minority game on genes

**What happens.** Every week, Shapes register non-custodially to the Void side (genes 0 to 2) or
the Solid side (4 to 6). Murk is neutral. **The side with *less* registered backing wins** the Tide
pot. Registration closes 24 hours before a **candle close**: a random block inside the last two
hours of the week.

**Why a degen cares.** A minority game has no stable equilibrium, so it flips forever. It gives two
factions and two colours for people to identify with. Changing side means changing gene, which
needs compose, decompose or split crafting. That creates constant demand for Void and Solid dust
from the Rig.

**Primitive.** Ink genes, the deterministic and previewable compose walk, decompose reversibility,
and `blackShapeCount` (Black Shapes could count as Void ×2).

**Failure modes.** At scale it becomes a coin flip. Holders with cards on both sides pick after
reading the registrations, which is why registration closes 24 hours early. Whale dominance.

---

## 3. The system

### Launch set (three mechanisms)

**M1 Rig + M2 Eclipse Eras + M3 Hold'em table (50 ETH) with the Floor.**

Era-0 daily emission: 1,000,000 $MARK.

| Sink / source | Share |
|---|---|
| Rig miners (hourly blocks of 25k) | 60% |
| Hold'em seat pot | 25% |
| Eclipse Bounty (accrues) | 15% |

- Burns: rig burn 0.002 ETH per mint, **in ETH**. $MARK seat antes burn 10%. Floor rake burns 3%.
- No premine. Nothing is sold at launch. The first liquidity comes from Rig output in hour one.
- The three clocks: **hourly** (mining block), **daily** (cutoff, flop, turn, river, showdown) and
  **unscheduled** (the eclipse).

Why these three: M1 creates the token and its cost anchor. M2 creates the unscheduled big event and
the descending line. M3 creates the daily appointment and the buy-side sink. Each one feeds the
next: mining produces dust origins (eclipse fuel) and pays for re-rolls (hands), and the Table
creates $MARK demand for antes and bets.

### Roadmap

| When | Add | Why then |
|---|---|---|
| Week 2 | **Crown stream**: 1% of emission to `owner()`, the holder of the owner token (#0 today) | Ties $MARK to the live #0 auction, where bids are Shape cards. The Crown follows #0 through compose, and a Black Crown is possible. Announcing it before the auction settles pumps the auction, so disclose that. |
| Month 2 | Omaha (10 ETH) and Six-card (5 ETH) tables; **Ace table** (100 ETH, one card, direct-hit on a single daily card, rollover jackpot) | Lowers the seat minimum. Rollovers are a separate attention engine. |
| Month 2 | **M4 Furnace** and eclipse syndicates | Once the first organic eclipse proves the loop, protocol-driven eclipses keep it running. |
| Month 3 | **M5 Ink Tide** | By then the dust crafting economy is liquid enough for genes to be a real cost. |
| Ongoing | Era leaderboards reset at each eclipse; eclipse-date prediction markets; pooled seat vaults for the 50 ETH tables | No terminal state: each eclipse is a new season. |

### User experience

**Day one.**
- 00:00 UTC: the Rig opens. The first hour's 25,000 $MARK splits across perhaps 40 mints, about
  625 $MARK each, so the cost basis is around 5e-6 ETH. Screenshots of that cost basis are the
  first content.
- Around 01:00: someone seeds a $MARK/ETH pool. The hashprice chart and price chart go live side
  by side.
- During the day: 50 ETH holders open `previewCompose` and the re-roll tool. "I spent 0.4 ETH
  re-rolling for pocket kings" is post number two.
- 23:00: the first seat cutoff. Twelve seats; hands are public.
- The Eclipse Bounty counter starts at 150,000 $MARK/day, with the Eclipse Line drawn on the chart
  far above the price.

**Week one.**
- Hashrate climbs until hashprice ≈ market price. The difficulty-adjustment behaviour is visible
  every hour.
- The daily flop, turn and river are three posts a day, each rendering the board as Shape
  archetypes.
- Floor pools get deep enough that equity-versus-odds arbitrage appears. Someone ships an equity
  bot.
- Pocket-pair 50s trade above par on secondary, capped by re-roll cost.
- Void and Solid dust trade at a premium near their re-roll cost of about 0.1 ETH.
- The first "someone is assembling a Complete" rumours. Indexers publish the Complete census.
- Bounty reaches 1.05M and the line is at 1.1e-4.

**Month one.**
- The line has fallen to about 2.6e-5. Either price has crossed it and the first eclipse happened,
  or everyone knows how far away it is.
- The first eclipse: a 100 ETH `burnBacking`, the first Black Shape, emission halves to 500k/day,
  and the bounty resets. The biggest content event in the system's life.
- Miners capitulate or consolidate. Leaderboards reset for era 1.
- Omaha and Six-card tables open, and the Furnace is announced so the next eclipse can be
  crowdfunded.

---

## 4. Where every participant can win (and the condition)

- **Arbers:** hashprice against market price; secondary hand premium against re-roll cost; Floor
  odds against computed equity; Eclipse Bounty against ~115 ETH.
- **Traders:** era transitions and eclipse watches create repeated, readable volatility events.
- **Holders:** halvings, ante and rake burns, the Furnace.
- **Seats:** risk-free capital that earns the emission subsidy and backer rake.

The condition, stated plainly: this only holds while inflows grow. See §5.

---

## 5. What breaks it

1. **The flow math is net inflationary for a long time.** To offset 1M $MARK/day of emission with a
   3% Floor burn, the Floor needs about 33M $MARK/day of volume, more than the whole supply at
   day 30. Seat antes help at the margin. Until the first eclipse or two, expect miner sell
   pressure to dominate and the price to trend down between hype spikes. The design depends on
   eclipses arriving before exhaustion. If they don't, it bleeds out. A time decay on emission
   (for example 2%/week on top of halvings) makes the bleed shorter. Decide that before launch.
2. **In ETH terms it's negative-sum.** Every ETH that enters $MARK leaves to the artist (fees), to
   `0xdead` (rig burns, eclipses, Furnace), to validators (gas) or to earlier holders. "Everyone
   wins" means everyone who is early or skilled wins, paid for by whoever comes late. That's the
   honest description of any reflexive game. Say it on the site.
3. **Artist and insider edges.** The fee edge in mining, pre-built Complete stock, knowing the
   bounty timing, and the Crown stream's effect on the live #0 auction. Each one invites a
   "rigged" narrative the day it's discovered. Disclose all of them on day one.
4. **Re-rolls are cheap.** Any mechanic that treats archetypes, hands or dust genes as scarce gets
   priced down to re-roll cost. Hands only carry value through *crowding* (split pots), never
   through rarity. Don't market rarity.
5. **Randomness.** A bare `prevrandao` draw can be biased by the proposer: withholding a block costs
   about one block reward, and Table pots will quickly be worth more than that. Use VRF or a
   multi-block commit. Mint seeds are already grindable, which is acceptable because it's priced in.
6. **Regulatory.** A daily parimutuel on seats paid in a token with an issuance schedule is wagering
   by most definitions, and the token is marketed around its price. That's a jurisdiction and
   frontend problem that code can't fix. Decide which frontends geofence what.
7. **Artistic consent.** Mapping the 52 archetypes onto playing cards and turning Shapes into chips
   overwrites the collection's restrained visual language with casino iconography. The artist has
   to be in on it or the relationship breaks. The contracts never change, but the story around the
   collection does.
8. **Chain and indexer load.** Hourly mining at scale means millions of dust tokens.
   `totalSupply`, marketplaces and indexers will degrade. Rig batching helps, but dust spam is a
   byproduct of the design, not a bug in it.
9. **Contract risk sits in $MARK contracts, not in Shapes.** Non-custodial seats remove the biggest
   honeypot. The Furnace is custodial by design and needs its own audit and a provably closed exit
   surface.
10. **Attention decays anyway.** Nested clocks slow the decay but don't stop it. The roadmap exists
    because each new table or faction resets novelty, and a long gap with nothing new is when
    systems like this die.
