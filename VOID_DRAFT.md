# VOID — an attention machine built on Shapes (draft v0.1)

Status: speculative design for discussion. Nothing here is built. Everything sits outside Shapes
and uses only its public interface; no change to Shapes is required. `VOID` is a working title.

---

## 0. The pitch

Shapes is the most honest object on Ethereum: ETH in, the same ETH out. VOID is its shadow: ETH in,
nothing guaranteed out.

VOID is a plain ERC-20 whose only market is a Uniswap v4 pool run by a hook (the **Engine**). The
Engine takes every fee in ETH and turns what it keeps into Shapes. Those Shapes are won, rained on
players, or burned, in public, on a clock the market winds itself. The token is the chip. Shapes are
the prizes, the ammunition and the sacrifice. Nobody runs it: no admin, no upgrades, no pause. The
only hands on the dials belong to whoever buys them, in VOID.

---

## 1. First principles → design rules

**Attention** is bought with stakes, stories, uncertainty, deadlines and status, and it decays in
days. A perpetual machine has to emit events faster than attention decays. It has to pay for them
out of its own flow, and make them bigger as it grows. The events must come from inside the
machine. The market is the clock; there is no team making announcements.

**Reflexivity.** A loop where price feeds rewards that feed price, with gain above 1, makes booms.
Booms alone make a rocket that falls back. To be perpetual, the down direction must also emit events
that recruit buyers: crashes are sales, silence is a bounty. The target is an oscillator.

**Microstructure.** The hook is the only liquidity provider, so the liquidity curve is a volatility
dial and the fee is a control surface. Every contest must also survive block builders. Any mechanic
that pays for being last in a block pays the builder, not the player.

The rules that fall out:

1. **Every prize is a Shape.** The house's stake is a pile of NFTs anyone can count. Every prize is
   exact, redeemable ETH with art on it.
2. **The market is the clock.** State changes happen inside swaps or in permissionless cranks that
   pay a bounty.
3. **No last-block games.** Every contest is a weighted draw with an end chosen at random after the
   fact (a candle auction). Where you land inside a block buys nothing, so builders capture nothing.
4. **Every contest is all-pay, and the payment is a burn or a fee.** Competition spends roughly the
   value of each prize (rent dissipation), and that spending becomes deflation or the next prize.
5. **Both directions are content.** Pumps change the rules (Surge), crashes change the rules
   (Rain), silence changes the rules (Calm).
6. **Bots are the bid.** Every bounty is shaped so the bot's best move is to buy or burn.
7. **The house keeps no floor.** ETH that circulating tokens can no longer reach is harvested into
   prizes.
8. **Nobody governs it.** The only dials are the Throne (the fee, within bounds) and the Vigil (the
   fate of each apex). Both are bought with VOID.

---

## 2. What we build on

### Shapes

| Shapes fact | What the machine does with it |
|---|---|
| Each NFT wraps exact ETH at one of 9 denominations | Prizes are legible and can't be rugged. A "5 ETH Candle" pays a 5 ETH Shape. |
| Grid density falls as value rises (5×5 at 0.01, one mark at 100) | The pot is one Shape climbing the ladder, so its artwork doubles as a fuel gauge. |
| `compose` keeps the survivor's id and seed, resamples its modules from the inputs (units-weighted), and walks its ink up to one step per rung (70% toward the pool's center, 20% toward its best, 10% toward its worst) | The **Heart** visibly absorbs the cards fed into it, and its ink can drift every rung. |
| Dust (0.01) mints roll the full ink lottery: Void 3 / Faint 7 / Sparse 15 / Murk 50 / Dense 15 / Rich 7 / Solid 3 %. Larger mints roll only Sparse/Murk/Dense | Loot must be dust. **Sparks** are 0.01 Shapes: 6% Mythic, 14% Rare. |
| Origins are created only by mints and are conserved | Every apex requires 10,000 mint events, at least 10 ETH of Shapes mint fees: its proof-of-work. |
| A Complete 100 can `burnBacking`: exactly 100 ETH to `0x…dEaD`, producing a Black Shape; `burnedBacking()` and `blackShapeCount()` are public | **The Eclipse.** This is the only way to make a Black Shape, and it's the machine's climax. |
| `mintFee()` is 0.001 ETH per Shape (admin can move it up to 0.01) | Every Candle, Spark and apex pays Shapes' fee recipient. The Engine reads `mintFee()` live. |
| ShapeAuctionHouse takes bids in Shape cards | An unclaimed Black Shape is sold there and the proceeds go into the next Candle. |

Gas facts (EXP-001): `mint(0.01)` costs 207k gas, `mintBatch(10)` 839k, one compose rung at most
986k, `burnBacking` 88k. A 10,000-dust apex takes exactly 3,333 composes, about 3.5B gas in total:
roughly 3.5 ETH at 1 gwei. **All-in cost of one apex ≈ 113.5 ETH** (100 backing + 10 mint fees + gas).

### Uniswap v4

- **Hook-owned liquidity.** `beforeAddLiquidity`/`beforeRemoveLiquidity` revert for everyone else.
  That means no just-in-time liquidity, no rug, and the curve is ours to reshape (the Harvest).
- **Per-swap dynamic fee.** Ignition, the Throne, the weather and Recoil all live in `beforeSwap`.
- **Return deltas.** Fees are taken in ETH in both directions. The same mechanism makes LIGHT
  (buy-and-burn) a single swap: `afterSwap` claims the VOID output and burns it.
- **A callback on every swap.** This carries the time-weighted average price (TWAP), weather
  changes, Candle state and fee accounting.
- **`hookData`** carries the LIGHT intent and the ticket beneficiary, so no identity checks are
  needed.

---

## 3. The machine at a glance

```
                 every swap: fee taken in ETH, both directions
                                   │
      ┌─────────────┬──────────────┼──────────────┬──────────────┐
     48%           30%            10%            10%             2%
   CANDLE          APEX          TITHE          THRONE          CRANK
     │              │               │               │               │
 Heart grows    10,000 origins   split among     the Regent      bounties for
 rung by rung   (+ tributes)     every Black     (pays rent in   stoke / seal
     │              │            Shape, forever  VOID, burned)
 Flicker →      Vigil: BURN vs TAKE
 random end         │                   │
     │       100 ETH → 0x…dEaD     Complete 100 → one TAKE staker
 Heart + Sparks  Black Shape → one BURN staker, earns the Tithe
 → weighted draw       (the losing side's VOID is burned either way)

 VOID sinks: LIGHT (Candle tickets) · Vigil losers + 20% early-exit penalty · Throne rent
```

### The attention calendar

| Cadence | Event | Trigger |
|---|---|---|
| every block | the Heart's ETH ticks up on screen | fees |
| hours | **Heart rung**: 1 or 4 cards minted and composed in, the grid collapses, the ink shifts | pot crosses a ladder rung |
| continuous | **Throne** seizures, foreclosures, sell-fee moves | anyone with VOID |
| 1–3× a day | **Candle**: 1-hour Flicker, random true end, the Heart and dozens of Sparks drawn | pot reaches its target tier |
| days | **Weather**: Surge, Rain, Calm | TWAP thresholds, silence |
| 2–10 weeks | **Eclipse**: 72-hour Vigil war, 100 ETH burned or won, the losing side's VOID burned | apex reaches 10,000 origins |
| milestones | **Dust Rush**: 10,000 Shapes minted in hours | FDV crosses the epoch line |
| rare | **Dowry race**: a whale burns 100 ETH to take the Tithe's backlog | Tithe seat worth more than 113.5 ETH |

### Who plays

| Player | Loop | What hooks them |
|---|---|---|
| Tourist | buy, LIGHT 0.05 ETH, watch the Heart | a Spark (6% Mythic) or, rarely, the Heart |
| Degen | every Candle; trades the Surge/Rain rhythm; Vigil wars | variable rewards, near-misses, deadlines |
| Bot | arbitrage, waking the Calm, burning in the Rain, stoke/seal bounties | bounties whose best move is buy/burn |
| Whale | the Throne, deciding Vigils, a private apex to win the Dowry | status, the fee dial, a perpetual Tithe seat |
| Shapes collector | Dust Rushes, Mythic Sparks, Hearts, Black Shapes | objects with provenance, redeemable for ETH |
| Cultist / Mercenary | BURN / TAKE | tribe, sunk cost |

---

## 4. The token and the pool

**VOID.** ERC-20 with 1,000,000,000 supply and 18 decimals. It supports `burn` and EIP-2612
`permit`, and has no owner, no transfer tax, no blacklist and no minting after genesis. The
degeneracy lives in the pool, not the token, so wallets, aggregators and lending markets see a
vanilla ERC-20.

**Allocation.** 800M (80%) go into one hook-owned liquidity position. 200M (20%) form the
Origin Reserve, emitted to apex tributors (§6). No team allocation.

**Pool.** Native ETH/VOID, dynamic-fee flag, hook = the Engine. The LP fee is overridden to 0 on
every swap: the hook is the only LP, so all value flows through the fee buckets.

**Launch curve.** VOID is placed single-sided from P0 = 2×10⁻⁸ ETH (FDV 20 ETH) up to the max tick,
as one position of constant liquidity L. The net ETH needed to reach FDV `F` is `16·(√(F/20) − 1)`.
A buy of `b` ETH moves price by about `2b / √(16 · 0.8F)`:

| FDV (ETH) | Net ETH in to get there | 1 ETH buy moves price |
|---:|---:|---:|
| 100 | 20 | 5.7% |
| 1,000 | 97 | 1.8% |
| 2,200 | 152 | 1.2% |
| 10,000 | 342 | 0.56% |
| 100,000 | 1,115 | 0.18% |

Launch FDV sets volatility for the life of the token. 20 ETH is deliberately thin.

**Ignition (anti-snipe that pays).** For the first 150 blocks (~30 min), fees on both sides start at
80% and fall linearly to the base. Ignition fees are split 50/50 between the Genesis Candle (target
1 ETH) and the first apex. Snipers still snipe; they just fund the first jackpot.

**Fee schedule.**

| Side | Fee |
|---|---|
| Buy (including LIGHT) | 1% |
| Sell | set by the Throne between 1% and 8%; 4% by default |
| Weather | ± adjustments (§9) |
| Recoil (always on) | a sell pays `max(0, rise since the block's first swap − 1%)`; a buy pays `max(0, drop − 1%)`; capped at 20% |
| Hard cap | 25% per side |

**Recoil kills sandwiches.** Take an attacker who front-runs with size `a` (moving price `m_a`)
around a victim who moves it `m_v`. Their gross is about `a·m_v`. Their back leg alone pays
`a·(4% + m_a + m_v − 1%)` in sell fee plus Recoil. Add the 1% buy fee and the net is about
`−a·(4% + m_a)` — negative for any sandwich.

**Plumbing.** Every fee is taken in ETH. On an exact-input buy, `beforeSwap` takes it from the ETH
input (specified-side delta). On an exact-input sell, `afterSwap` takes it from the ETH output
(unspecified-side delta). Exact-output swaps mirror these. ETH fees accrue as ERC-6909 claims in
the PoolManager and cranks withdraw them in batches, which is cheaper than a transfer per swap.
The fee is routed Candle 48% (10% of that
funds Sparks), Apex 30%, Tithe 10%, Throne 10%, Crank 2% (capped at 5 ETH, with overflow going to
the Candle). With buy and sell volume equal and default fees, the blended take is **2.5%**.

---

## 5. The Candle — the daily jackpot

A perpetual, all-pay, burn-to-enter lottery. Its prize is one Shape that grows on-chain in front of
everyone.

**The Heart.** Each Candle opens by minting one dust Shape into the **Reliquary** (the Engine's NFT
vault). This is the **Wick**, and it becomes the Heart. The Wick is a dust mint, so a Candle can be
born Void or Solid. As the Candle's ETH crosses each ladder rung, `stoke()` mints the difference and
composes it in: one card on a ×2 rung, four on a ×5 rung. The Heart keeps its id and seed while
its grid collapses:

5×5 → 4×5 → 4×4 → 3×4 → 3×3 → 2×3 → 2×2 → 1×2 → 1×1

Its marks are resampled from the cards fed into it, and its ink can walk one step per rung. ETH
between rungs is the **Wax**. A 5 ETH Heart costs 15 mints (0.015 ETH of Shapes fees); a 100 ETH
Heart costs 21. The SVG is fully on-chain, so every bot and every post can show the exact prize.

**Lighting.** Tickets come only from burning VOID, in one of two ways:
- swap ETH→VOID with `hookData = LIGHT(beneficiary)`, and the hook claims the VOID output in
  `afterSwap` and burns it in the same swap; or
- call `light(amount)` with VOID you already hold.

`tickets = VOID burned × Kindling × weather`

- **Kindling** multiplies by `(2 − progress)`, where `progress = pot / target` (capped at 1). Burning
  into an empty Candle is worth 2×. Together with the AMM price rising under LIGHT buys, this
  recreates FOMO3D's rising key price without a key contract.
- **Rain** doubles tickets. **Calm** multiplies the first LIGHT after 12 hours of silence by 5.

**The Flicker (candle ending).** When the pot reaches its target, a 300-block (~1 hour) Flicker
begins, and fees start flowing to the next Candle. After the Flicker, the **true end** is drawn
uniformly from those 300 blocks. Only tickets lit at or before the true end count. Later tickets roll
into the next Candle without the Kindling bonus. Nobody knows which block ended it, so the last block
is worth no more than any other: no sniping, no block stuffing, nothing for builders to auction. The
fear of landing after the end pulls burns earlier and spreads the climax across the whole hour.

**The draw.** One weighted draw picks the Heart's winner. Up to 1,000 more weighted draws (with
replacement, chunked across crank calls) assign **Sparks**. Sparks cost 0.011 ETH each (dust plus
mint fee) and are funded by 10% of the Candle's inflow. `stoke()` mints them into the Reliquary
before the draw's randomness exists, so nobody can grind the gene of a Spark they'll receive. Each
Spark carries dust ink odds (6% Mythic, 14% Rare) and redeems for 0.01 ETH. Prizes are claimed, not
pushed.

**The Candle breathes (adaptive tier).** Targets move along 0.1, 0.5, 1, 5, 10, 50, 100 ETH:
- a Candle that hit its target in under 8 hours steps the next target up;
- one that took over 48 hours steps it down;
- anything in between keeps the target.

Every rung is ×2 or ×5 and the band is ×6, so the tier always settles where a Candle lasts 8–48
hours. There is a 72-hour hard cap: the Flicker starts with whatever Heart and Wax exist, and the
target steps down. A Candle nobody lights pays nobody. Its Heart carries over and keeps growing.

| Volume/day | Heart inflow/day | Settled target | Candles/day | Sparks/day (Mythic) |
|---:|---:|---:|---:|---:|
| 50 ETH | 0.54 | 0.5 ETH | 1.1 | 5 (0.3) |
| 200 | 2.2 | 1 | 2.2 | 22 (1.3) |
| 1,000 | 10.8 | 5 | 2.2 | 109 (6.5) |
| 5,000 | 54 | 50 | 1.1 | 545 (33) |
| 20,000 | 317* | 100 | 3.2 | 3,170 (190) |

\* includes apex surplus once the Vigil is the bottleneck (§6).

**Why it's reflexive.** It's a Tullock contest: rational players collectively burn about
`(n−1)/n × prize`. So each Candle converts **0.5–1× its Heart into burned VOID**, and the LIGHT buys
that did the burning pushed price up on the way in. Everyone else's trading fees fund a lottery with
a negative house edge until competition prices it down to zero. In quiet markets it's +EV just to
show up: one tiny ticket in an empty Candle wins the whole Heart. That's the resurrection property
a dying token needs.

---

## 6. The Eclipse — the apex ritual

**The apex.** A Complete 100 ETH Shape (10,000 origins), assembled in the Reliquary from two
sources.

1. **Fee-funded.** The Engine mints dust with the Apex bucket. Fee-only cadence is
   `113.5 / (0.0075 · V)` days: at 200 ETH/day, every 76 days; at 1,000, every 15; at 5,000,
   every 3. Above about 5,000 ETH/day the 72-hour Vigil becomes the bottleneck. At most one apex
   waits behind the live Vigil, and the Apex bucket's surplus flows into the Candle.
2. **Tribute.** Anyone can hand the Reliquary full-density Shapes (dust, or Complete 0.05 through
   Complete 50) while the apex has room. The check is `originCount × 0.01 ETH == backing`. Each
   origin earns VOID from the Origin Reserve, either staked on a Vigil side (full rate) or liquid
   (half). Epoch `k` is apex `k`, and the rate halves every epoch:

| Epoch | VOID/origin, staked | Liquid | Liquid breakeven FDV |
|---:|---:|---:|---:|
| 1 | 10,000 | 5,000 | 2,200 ETH |
| 2 | 5,000 | 2,500 | 4,400 |
| 3 | 2,500 | 1,250 | 8,800 |
| 4 | 1,250 | 625 | 17,600 |

When FDV crosses the epoch line, minting dust to tribute turns profitable: a **Dust Rush**. 10,000
Shapes get minted in hours (10 ETH to Shapes' fee recipient), the apex fills, the Vigil opens, and
the next line doubles. It's a halving schedule with a visible line on the chart: "Epoch 2 opens at
4,400."

Dust tributes take a 10% haircut, because the Engine pays for the ~3,333 composes a pure-dust apex
needs. Pre-assembled Complete 1 ETH+ pieces get the full rate. Assembly always succeeds: the ladder
is a divisibility chain (0.01 | 0.05 | 0.1 | … | 100), so the pieces below any tier D always sum to a
multiple of D and merge bottom-up.

**The Vigil (72 hours).** Once the apex is Complete, players stake VOID on **BURN** or **TAKE**.

- **Hours 0–48:** stake freely; withdrawing burns 20% of the stake.
- **Hours 48–72 (the Flicker):** no withdrawals. The true end is drawn uniformly from these 7,200
  blocks using a verifiable random function (VRF).
- **At the true end:** the side with more stake wins; ties go to BURN. Stakes placed after the true
  end are refunded.
- **Settlement:** the losing side's entire stake is burned; the winning side's stake is returned.

The two outcomes:

- **BURN.** The Reliquary calls `burnBacking` and exactly 100 ETH goes to `0x…dEaD`. A Black Shape
  is born, automatically enshrined in the Tithe, and awarded to one BURN staker, drawn weighted by
  stake.
- **TAKE.** The Complete 100 is awarded to one TAKE staker, drawn weighted by stake. TAKE means
  "give one degen the choice." They can:
  - redeem it for 100 ETH;
  - keep the rarest non-Black formation in Shapes;
  - split it into 100 Complete 1 ETH pieces and tribute them into the next apex for VOID;
  - burn it themselves later and enshrine their own Black Shape.
- **Nobody staked.** BURN by default. The Black Shape is listed in ShapeAuctionHouse, and the winning
  bid (in Shape cards) goes into the next Candle.

**What the vote really is.** BURN's prize is a perpetual Tithe seat (§7); TAKE's is 100 ETH now. So
each Eclipse is a market-implied referendum on VOID's future volume: believers burn, mercenaries
take. It's a tug-of-war with sunk costs and a random ending, so it escalates like a dollar auction,
and every VOID escalated on the losing side is destroyed.

---

## 7. The Tithe — Black Shapes earn forever — and the Dowry race

10% of all fees flow to Black Shapes, split equally among every Black Shape enshrined with the
Engine. **Enshrinement is open.** Any live Black Shape can call `enshrine(id)` once, whether an
Eclipse made it or someone assembled their own Complete 100 and burned it. Claims pay
`ownerOf(id)` at claim time, so Black Shapes become transferable, yield-bearing objects. A Black
Shape destroyed through `burn` stops earning.

**The Dowry.** Until the first Black Shape exists, the Tithe accumulates, and the first one
enshrined takes all of it. At 1,000 ETH/day of volume the Dowry grows by 2.5 ETH/day. Once the Dowry
plus the value of being the only Tithe seat passes about 113.5 ETH, a whale can beat the
community's own Eclipse by building an apex privately and burning it first. Racing the Eclipse is a
spectacle either way.

**Equilibrium.** Black Shapes keep getting made until one more seat is worth only what it costs to
make one: `n* ≈ 365 · Tithe/day / (113.5 · r)`, where `r` is the discount rate.

| Volume/day | Tithe/day | n* (r = 100%/yr) | n* (r = 300%/yr) | ETH burned at n* |
|---:|---:|---:|---:|---:|
| 200 | 0.5 | 1.6 | 0.5 | ~50–160 |
| 1,000 | 2.5 | 8 | 2.7 | ~270–800 |
| 5,000 | 12.5 | 40 | 13 | ~1,300–4,000 |
| 20,000 | 50 | 161 | 54 | ~5,400–16,000 |

VOID's volume turns into burned ETH at a rate the market sets. Shapes' own `blackShapeCount()` and
`burnedBacking()` become VOID's public scoreboard, and each independent Black Shape also pays at
least 10 ETH in Shapes mint fees.

---

## 8. The Throne — a Harberger seat on the fee dial

One seat, taxed Harberger-style, modeled on an auction-managed AMM (am-AMM). You lease the right to
turn the fee dial.

- **Rent.** The **Regent** declares a price `V` in VOID and pays rent of 5% of `V` per day from a
  VOID deposit. Rent is burned.
- **Seizure.** Anyone can take the seat at any time by paying `V` to the Regent and posting a new
  price and deposit. Minimum price is 1M VOID; at most one seizure per block.
- **Income.** 10% of all fees, in ETH, streamed per second of tenure.
- **Power.** Sets the base sell fee between 1% and 8%, moving it at most 1 percentage point per
  hour. A change takes effect 50 blocks after it's announced, so the Regent can't ambush a whale's
  sell.
- **Foreclosure.** If the deposit hits zero, the **Interregnum** begins: the sell fee reverts to 4%
  and the Throne's 10% flows to the Candle until someone takes the seat.

**Equilibrium.** Competition pushes rent toward income, so the seat prices at about 20 days of Throne
income. About 10% of all fee revenue becomes burned VOID, paid by whoever is most bullish on next
month's volume. At 1,000 ETH/day that's roughly 2.5 ETH/day of VOID burned, on a seat worth about
50 ETH of VOID. The seat price is a live, tradeable forecast of volume, and the Regent's fee is a
live forecast of what the market will bear.

---

## 9. Weather — price action rewrites the rules

The Engine keeps a 30-minute TWAP (one observation per block, written by that block's first swap)
along with the 7-day high of that TWAP.

| Weather | Trigger | Lasts | Effect | Cooldown |
|---|---|---|---|---|
| **Surge** | TWAP > 1.10 × all-time-high TWAP | 60 min | sells +3 pp, buys −0.5 pp | 6 h |
| **Rain** | TWAP < 0.50 × 7-day high TWAP | 120 min | LIGHT tickets ×2; sell fee −2 pp (floor 1%) | 72 h |
| **Calm** | 12 h without a swap | until the next LIGHT | that LIGHT's tickets ×5; Candle target steps down | — |

- **Surge.** Taxing profit-taking right after a breakout makes the breakout stick for an hour. Then
  everyone who waited out the tax sells at once. The result is a predictable pump-then-dump rhythm
  people can trade.
- **Rain** is a trap door at −50%. Sellers wait for the cheaper fee and then flush; burners buy
  double-weight tickets into the flush. Crashes become ticket sales, and V-shaped bottoms become
  content.
- **Calm.** Silence becomes a bounty: the first mover is buying tickets against nobody.

**Manipulation costs.** Buying a Rain means dragging the 30-minute TWAP to half the 7-day high. That
takes selling ≥29% of the pool's virtual ETH reserve and buying it back, about 1.5% of the reserve
in fees round trip, before 30 minutes of fighting dip buyers:

| FDV | Virtual ETH reserve | Fee cost of a manufactured Rain |
|---:|---:|---:|
| 200 | 51 | ≈ 0.7 ETH |
| 1,000 | 113 | ≈ 1.7 ETH |
| 10,000 | 358 | ≈ 5.2 ETH |

What it buys is a public, 2-hour, double-ticket window that anyone can burn into; at most a fraction
of one Candle is capturable. It's allowed: a crash someone paid for is still an event. Farming Surge
fails because the all-time-high TWAP ratchets up, so each attempt costs more than the last.

---

## 10. The Harvest — no floor

Every VOID burned leaves ETH in the pool that no circulating token can ever reach. With one position
of constant L, sell every VOID outside the pool and price bottoms at `p_floor`:

`1/√p_floor = 1/√P + C/L`, where `C = totalSupply − VOID in the pool`

`C` counts the reserve, Vigil stakes and Throne deposits. Trades only move VOID between the pool and
the outside, which leaves this sum unchanged. **`p_floor` moves only when VOID is burned, so it
can't be manipulated with price.** `harvest()` re-mints the position with its lower bound at
`p_floor` (rounded down a tick, 1% margin) and splits the freed ETH 50/50 between the Candle and the
apex.

The freed ETH is `16 ETH × x/(1−x)`, where `x = (VOID burned − 200M)/800M`:

| VOID burned | Harvestable |
|---:|---:|
| 200M | 0 |
| 400M | 5.3 ETH |
| 600M | 16 |
| 800M | 48 |
| 900M | 112 |

It's small early and convex late: the last tokens standing unlock the floor. Each Eclipse's
losing-side burn is followed by a Harvest into the next Candle (a Blood Candle). And if every holder
sells, price falls to the bottom of the harvested range: there is no floor, by design. Shapes hold
ETH; VOID holds nothing it doesn't have to.

---

## 11. The loops, by market regime

**Mania.**
- Candle tiers climb to 50–100 ETH, and a 100 ETH Heart is one mark alone on black.
- The Throne reprices up, the Regent pushes the sell fee higher, and the Tithe swells.
- Dust Rushes fill apexes in hours, and BURN wins because a Tithe seat is worth more than 100 ETH.
  ETH burns, Black Shapes appear, whales race for the Dowry.
- Each Vigil's losing side takes a slab of supply with it, and Surge windows stretch every breakout.

**Crash.**
- Rain arrives at −50% with double tickets.
- Candle pots are denominated in ETH and lag the crash, so ticket value per ETH rises as VOID gets
  cheaper.
- The Throne forecloses, and its cut flows to the Candle.
- TAKE starts winning Eclipses: "someone won 100 ETH on a dead memecoin" is marketing money can't
  buy.

**Dead.**
- Candle targets fall to 0.1–0.5 ETH, but the 72-hour cap still forces a draw.
- Calm pays ×5 to whoever wakes it, and unplayed Hearts keep growing across Candles.
- The apex bucket and the Tithe keep accruing on whatever trickles in.

The machine can sleep but it can't die. There is always a prize sitting in public, and the fewer the
players, the better the odds.

---

## 12. Scenario table

Assumptions: buy and sell volume equal, buy 1%, sell 4%, 1 gwei. "VOID burned" counts Candle LIGHT
(0.5–1× the Heart) plus Throne rent. It excludes Vigil losers and early-exit penalties.

| Volume/day | Fees/day | Candle | Candles/day | Sparks/day (Mythic) | Eclipse every (fees only) | Tithe/day | VOID burned/day (ETH value) | Shapes mint fees/day |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 1.25 | 0.5 | 1.1 | 5 (0.3) | 303 d | 0.13 | 0.4–0.7 | 0.05 |
| 200 | 5 | 1 | 2.2 | 22 (1.3) | 76 d | 0.5 | 1.6–2.7 | 0.18 |
| 1,000 | 25 | 5 | 2.2 | 109 (6.5) | 15 d | 2.5 | 7.9–13.3 | 0.80 |
| 5,000 | 125 | 50 | 1.1 | 545 (33) | 3 d | 12.5 | 40–67 | 3.9 |
| 20,000 | 500 | 100 | 3.2 | 3,170 (190) | ~3 d (Vigil-bound; surplus → Candle) | 50 | 209–367 | 6.6 |

At volume/FDV = 0.5 per day, typical for a live memecoin, the Candle and Throne alone burn **0.4–0.7%
of supply per day**, before a single Vigil loser.

---

## 13. The adversary's notebook

| Attack | Why it fails, or what it costs | Residual |
|---|---|---|
| Launch sniping | Ignition fee starts at 80%; snipers seed the Genesis pots | they snipe anyway and pay for the show |
| Sandwiching | Recoil: the back leg pays at least the move it harvests, plus 5% base round trip | none material |
| JIT / external LPs | `beforeAddLiquidity` reverts for anyone but the hook | — |
| Last-block sniping, block stuffing, builder bribes | Candle and Vigil end at a random block chosen after the fact; order inside a block is worthless | — |
| Randomness bias | Candle: `prevrandao` of a block committed in advance, sealed by a keeper paid a bounty, so a proposer holds at most a 1-bit include/exclude option. Eclipse: VRF | 1-bit option on Candles |
| Gene grinding | Sparks are minted before the draw's randomness exists | a `stoke()` caller can grind a Heart's ink, which is cosmetic; Shapes already accepts grinding as a residual |
| Manufactured Rain | ~1.5% of virtual ETH in fees plus 30 min against dip buyers; it buys a public event | allowed |
| Surge farming | the all-time-high TWAP ratchets; each farm costs more | — |
| Throne fee ambush | at most ±1 pp/hour, a 50-block delay, bounded to 1–8% | the Regent can raise fees into known events (that's the job) |
| Flash-staking the Vigil | stakes lock until resolution | borrowed VOID is at the borrower's risk |
| Vigil last-second flip | random end in the last 24 h; stakes after it are refunded | coalitions and bribes are the game |
| Apex tribute griefing | full-density and capacity checks; the divisible ladder always assembles; the dust haircut pays assembly gas | — |
| Tithe dilution | anyone can enshrine a Black Shape, by design, at 113.5 ETH each | — |
| Harvest error | `p_floor` is unchanged by trades; `C` counts every VOID outside the pool; 1% margin; tick rounded down | — |
| Venue leakage | a third party can pool VOID elsewhere at lower fees; arbitrage aligns price but fees leak | LIGHT, tickets, Throne and Tithe exist only on the canonical pool |
| Shapes admin moves `mintFee` | read live; at the 0.01 cap a pure-dust apex goes from ~113.5 to ~203.5 ETH | external dependency (§17) |
| Wash trading | nothing rewards raw volume; the Regent recovers only 10% of fees they pay | — |

---

## 14. Hook and contract sketch

**Contracts** (all immutable, no owner):
- **VoidToken:** ERC-20 plus `burn` and `permit`.
- **VoidEngine:** the v4 hook. Flags: `BEFORE_INITIALIZE`, `BEFORE_ADD_LIQUIDITY`,
  `BEFORE_REMOVE_LIQUIDITY`, `BEFORE_SWAP`, `AFTER_SWAP`, `BEFORE_SWAP_RETURNS_DELTA`,
  `AFTER_SWAP_RETURNS_DELTA`, and `BEFORE_DONATE` to reject donations. The address is mined with
  CREATE2 so it carries those bits.
- **Reliquary:** an ERC-721 receiver and the only contract that calls Shapes (`mintBatchTo`,
  `compose`, `composeMany`, `burnBacking`, `safeTransferFrom`) and ShapeAuctionHouse.
- **Candle, Eclipse (apex + tribute + Vigil), Throne, Tithe:** modules called by the Engine, split
  to stay under EIP-170's size limit.

**Callbacks:**
- **`beforeInitialize`:** only the canonical PoolKey, only once, only at P0.
- **`beforeAdd/RemoveLiquidity`:** `require(sender == address(this))`.
- **`beforeSwap`:** `fee = clamp(base + Ignition + weather + Recoil, 0, 25%)`. Takes exact-input buy
  fees from the ETH input and returns `lpFeeOverride = 0 | OVERRIDE_FEE_FLAG`.
- **`afterSwap`:**
  - takes the ETH fee on sells and exact-output buys;
  - routes fees into a packed bucket slot;
  - the block's first swap writes the TWAP observation and opening sqrtPrice;
  - updates weather and checks whether the pot has reached its target (which flips the Candle to
    Flicker);
  - on LIGHT, claims the VOID output, burns it and appends a ticket.

```solidity
// sketch: exact-input paths only; exact-output mirrors them. Sign conventions per v4 delta rules.
function beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
    external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24)
{
    BeforeSwapDelta d = BeforeSwapDeltaLibrary.ZERO_DELTA;
    if (p.zeroForOne && p.amountSpecified < 0) {           // buy: ETH in, fee off the top
        uint256 fee = uint256(-p.amountSpecified) * buyFeeBps() / 10_000;
        poolManager.mint(address(this), key.currency0.toId(), fee); // accrue as ERC-6909 claim
        _route(fee);                                        // 48 / 30 / 10 / 10 / 2
        d = toBeforeSwapDelta(int128(int256(fee)), 0);
    }
    return (this.beforeSwap.selector, d, LPFeeLibrary.OVERRIDE_FEE_FLAG); // LP fee 0
}

function afterSwap(address, PoolKey calldata key, SwapParams calldata p, BalanceDelta delta,
    bytes calldata data) external onlyPoolManager returns (bytes4, int128 hookDelta)
{
    _tickBlock();                                           // TWAP obs, block-open price, weather
    if (!p.zeroForOne) {                                    // sell: fee off the ETH output
        uint256 fee = uint256(int256(delta.amount0())) * sellFeeBps() / 10_000;
        poolManager.mint(address(this), key.currency0.toId(), fee);
        _route(fee);
        hookDelta = int128(int256(fee));
    } else if (data.length > 0 && data[0] == LIGHT) {       // buy-and-burn in one swap
        address who = abi.decode(data[1:], (address));
        uint256 out = uint256(int256(delta.amount1()));     // VOID the swapper would have received
        poolManager.take(key.currency1, address(this), out);
        VOID.burn(out);
        candle.light(who, out);                              // × Kindling × weather
        hookDelta = int128(int256(out));                     // swapper receives 0 VOID
    }
    candle.poke();                                           // pot >= target → Flicker
    return (this.afterSwap.selector, hookDelta);
}
```

**Gas overhead targets:** a plain swap +25–40k; a LIGHT swap +80–100k.

**Cranks.** Permissionless; each pays `gas × basefee × 1.2` plus a tip from the Crank bucket.
- `stoke()`: Heart rungs, Spark batches, apex dust mints (`mintBatchTo` in batches of ≤50), apex
  assembly (bounded `composeMany`), `harvest()`.
- `seal()`: stores `block.prevrandao` in the block committed at Flicker end (flickerEnd + 2).
- `settleCandle()` / `resolveEclipse()`: run the draws, mark prizes claimable, open the next round.

**Storage.**
- **Tickets:** an append-only array of `(address, uint96 cumulative)` plus per-block checkpoints,
  making the draw `O(log n)`.
- **Vigil:** checkpoints of `(block, burnTotal, takeTotal)`.
- **Weather:** 30-minute TWAP from a ring buffer; the 7-day high from seven daily-max slots.

---

## 15. Parameters

| Parameter | Value |
|---|---|
| Supply | 1,000,000,000 VOID |
| Curve / Origin Reserve / team | 80% / 20% / 0% |
| Launch FDV | 20 ETH (P0 = 2×10⁻⁸ ETH) |
| Ignition | 80% → base over 150 blocks; fees 50/50 to Genesis Candle and first apex |
| Buy fee / sell fee | 1% / Throne-set 1–8%, default 4% |
| Recoil | adverse in-block move − 1%, capped at 20% |
| Fee hard cap | 25% per side |
| Fee split | Candle 48 (Sparks = 10% of it) / Apex 30 / Tithe 10 / Throne 10 / Crank 2 |
| Candle tiers | 0.1, 0.5, 1, 5, 10, 50, 100 ETH; up if under 8 h, down if over 48 h, 72 h cap; Genesis 1 ETH |
| Flicker | 300 blocks |
| Kindling | × (2 − pot/target) |
| Sparks | dust, ≤ 1,000 per Candle |
| Apex queue | at most one apex waits behind the live Vigil; surplus → Candle |
| Vigil | 72 h; Flicker = last 24 h; early exit burns 20%; tie → BURN |
| Tribute | Epoch 1: 10,000 VOID/origin staked, 5,000 liquid; halves per epoch; dust −10% |
| Tithe | 10% of fees, equal per enshrined Black Shape; Dowry to the first |
| Throne | rent 5%/day; min price 1M VOID; income 10%; fee change ±1 pp/h with a 50-block delay |
| Surge | TWAP > 1.10× all-time high: 60 min, sells +3 pp, buys −0.5 pp; 6 h cooldown |
| Rain | TWAP < 0.5× 7-day high: 120 min, tickets ×2, sells −2 pp; 72 h cooldown |
| Calm | 12 h silence: next LIGHT ×5, Candle target steps down |
| Harvest | lower bound → `p_floor` × 0.99; ETH 50/50 Candle/apex |
| Randomness | Candle: sealed `prevrandao` (+2 blocks); Eclipse: VRF |

---

## 16. Dials to 11 (optional)

- **Snuff.** During a Flicker, burn X VOID to delete X of the leading ticket-holder's tickets. It's
  pure spite and pure deflation, and whales have to defend their lead.
- **Storm liquidity.** During each Flicker the Engine pulls 50% of its liquidity, so every LIGHT
  moves price twice as far. Afterwards it re-adds at the new price, burns leftover VOID and sends
  leftover ETH to the Candle. This breaks the single-position Harvest invariant unless a harvest
  runs before each Storm.
- **The Owner Candle.** If the Reliquary ever holds Shape #0, compose it into a Heart. Compose moves
  collection ownership to the survivor, so that Candle's winner becomes `owner()` of Shapes.
- **Positions pointer.** Point Shapes' `positions()` at a resolver that reports the Engine for every
  Shape in the Reliquary (Hearts, apex pieces, Sparks awaiting claim). Every surface that reads
  Shapes' canonical interface would then show the game.

---

## 17. Open decisions

1. **Launch FDV.** This sets volatility for life. 20 ETH is thin on purpose.
2. **Fee split.** 48/30 trades daily jackpots against Eclipse cadence. Moving 10 points to the apex
   cuts Eclipse spacing by 25%.
3. **Eclipse randomness.** VRF (an external dependency) versus sealed `prevrandao` (a 1-bit
   proposer option on a 100 ETH outcome).
4. **The Shapes `mintFee` dependency.** Shapes' admin can raise it to 0.01, which takes a dust apex
   from ~113.5 to ~203.5 ETH. Whoever holds that admin shapes VOID's economics, and players will price
   it in. Decide whether to commit, lock or renounce before launch. Note that VOID's flow also pays
   Shapes' fee recipient: about 0.8 ETH/day at 1,000 ETH/day of volume at today's fee, and at least
   10 ETH per independent Black Shape.
5. **The Harvest.** On (no floor, bigger prizes) or off (an emergent floor that rises with burns).
6. **Canonical venue.** Accept fee leakage to third-party pools with a vanilla ERC-20, or add a
   transfer rule and lose composability.
7. **Dials to 11.** Which of §16 ships.
