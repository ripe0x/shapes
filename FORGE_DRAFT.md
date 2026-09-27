# The Forge — a Strategy token that only Shapes could have (draft v0.1)

Status: speculative design for discussion. Nothing is built, and it needs no change to Shapes.
It supersedes `VOID_DRAFT.md`. `PURE` is a working title for the token.

---

## 0. The idea in one paragraph

PunkStrategy turned a token into a machine: trading fees buy a CryptoPunk off the floor, the Punk
is relisted at a markup, and when it sells the proceeds buy back and burn the token. The Forge keeps
that loop but changes what the machine does with the money. Punks can only be bought and resold.
Shapes can be *made*. So the Forge doesn't buy anything. It mints Shapes, keeps the rare ones,
cashes in the rest, fuses the rare ones into pure single-gene pieces, and sells those. Every sale's
profit buys PURE back and burns it. The long quest is one pure 100 ETH Shape, burned into a Black
Shape.

---

## 1. First principles: why PunkStrategy works, and what doesn't carry over

The PunkStrategy loop has four parts:

1. **Trading makes money.** A high fee on every trade turns attention into ETH.
2. **The money buys something scarce.** Buying off the floor takes supply off the market.
3. **The scarce thing is resold at a markup.** That's where profit comes from.
4. **Profit buys and burns the token.** The token's supply shrinks as the machine works.

Part 2 doesn't carry over to Shapes. A Shape's floor is its ETH. Anyone can mint any Shape for its
backing plus 0.001 ETH, and anyone can cash one in for exactly its backing. There's no floor to
sweep, because nobody ever has to sell below what the Shape holds.

What Shapes have instead is a way to make rarity out of process:

| Shapes property | What it gives a machine |
|---|---|
| Every Shape cashes in for exactly its ETH | Inventory can't lose value. The machine's only real cost is minting fees and gas. |
| 0.01 ETH mints roll a random ink gene: Void 3%, Faint 7%, Sparse 15%, Murk 50%, Dense 15%, Rich 7%, Solid 3% | Rarity that must be mined. About 1 in 17 mints is Mythic (Void or Solid). |
| Merging Shapes that all share one gene keeps that gene, guaranteed | Purity is buildable: 100 Void mints merged together make a Void 1 ETH, every time. |
| Merged art is redrawn from the pieces' marks | A pure Void piece has every mark outlined; a pure Solid piece has every mark filled. You can see the purity. |
| "Complete" means every 0.01 inside came from its own mint | Every forged piece is Complete, a status only mints can create. |
| Only a Complete 100 ETH Shape can be burned into a Black Shape | The quest: a pure 100 ETH piece, burned. |
| Merge outcomes can be previewed before doing them | Nothing is gambled after mining. The forge knows exactly what it will make. |
| Every mint pays the Shapes mint fee | The machine's work funds the Shapes artist. |

So the Shapes version of "buy the floor" is **mine the rare**. The markup is the premium a collector
pays for a pure, Complete, provably forged piece over the ETH it holds.

---

## 2. The loop

```
 trades ──10% fee──▶ Forge treasury
                        │
                     MINE: mint 0.01 Shapes in batches
                        │
             SORT: keep Void / Solid ── cash in everything else (get the 0.01 back)
                        │
             FUSE: merge same-gene pieces up the ladder
                   5 → 0.05 · 10 → 0.1 · 50 → 0.5 · 100 → 1 ETH …
                        │
             SELL: list each finished piece at cost × 1.2
                        │
             sale ──▶ cost returns to the treasury (keeps mining)
                  └─▶ profit buys PURE from the pool and burns it
```

Every step is a public function anyone can trigger for a small reward, like PunkStrategy's buy
button. Nobody runs the machine.

### Mine
The treasury mints 0.01 ETH Shapes in batches of up to 50. Each mint costs 0.001 ETH in Shapes fees
and roughly 0.0001 ETH in gas at 1 gwei. The backing isn't a cost: it comes straight back when a
piece is cashed in or sold.

### Sort
Right after a batch, everything that isn't Void or Solid is cashed in for its 0.01. Only Mythics
stay. So each Mythic costs about **0.018 ETH** to find (0.0011 per mint ÷ 6%).

A knob: also keep Faint and Rich (the 7% "Rare" genes) as a second, cheaper product line.

### Fuse
Same-gene pieces merge up the ladder: five 0.01s into a 0.05, two 0.05s into a 0.1, and so on.
Because every input shares the gene, the result keeps it. Each finished piece is pure and Complete.

### Sell
Each finished piece is listed at **cost × 1.2**, where cost is its ETH plus the mining spent on it.
That's PunkStrategy's markup. What a pure piece costs to make, mined:

| Pure piece | Mythics inside | Cost to make | Listed at |
|---|---:|---:|---:|
| 0.05 ETH | 5 | 0.14 ETH | 0.17 ETH |
| 0.1 ETH | 10 | 0.28 | 0.34 |
| 0.5 ETH | 50 | 1.40 | 1.68 |
| 1 ETH | 100 | 2.81 | 3.37 |
| 10 ETH | 1,000 | 28 | 34 |

When a piece sells, its cost returns to the treasury to keep mining and the 20% profit buys and
burns PURE. If a piece hasn't sold after 30 days, its price slides down toward its ETH value. At
worst the forge cashes it in and loses only the mining fees. Unlike a Punk, a forged piece can never
be worth less than the ETH inside it.

Finished pieces could also go through the Shapes auction house instead of a fixed price, with the
cost × 1.2 as the reserve. Bids there are paid in Shape cards, which the forge can cash in.

---

## 3. The token

- **PURE:** a plain ERC-20, 1B supply, no team allocation, and no owner.
- **Uniswap v4 pool, hook-owned liquidity.** Nobody else can add or pull liquidity.
- **Fee: 10% on buys and sells, taken in ETH.** Like PunkStrategy, it starts near 95% at launch and
  decays to 10% over the first hour, so snipers pay for the first batches.
- **Fee split:** 8% forge treasury, 1% crank rewards, 1% to you (tunable).
- **Buybacks go through the same pool,** so every sale shows up on the chart as a buy followed by a
  burn.

The holder's pitch is the same as PunkStrategy's: you own a share of a machine that works around the
clock. The difference is the machine makes things instead of flipping them, and its inventory can't
drop below its ETH.

---

## 4. What your volume produces

At ETH ≈ $3,500, a normal day is $150k (43 ETH) and a peak day is $1M (285 ETH).

| | Normal day | Peak day |
|---|---:|---:|
| Fees | 4.3 ETH | 28.5 ETH |
| Forge budget (8%) | 3.4 ETH | 22.8 ETH |
| Shapes minted | 2,000–3,200 | 13,500–21,000 |
| Mythics found (Void + Solid) | 120–190 | 810–1,260 |
| Pure 1 ETH pieces per gene | one every ~1–1.6 days | 4–6 a day |
| Paid to the Shapes artist in mint fees | 2–3 ETH | 13–21 ETH |

The lower mint numbers are the cold start, while mined backing is still waiting to be sold. The upper
numbers are the steady state once sales recycle it.

---

## 5. The Great Work

The long quest is one pure Void (or pure Solid) Complete 100 ETH Shape: 10,000 Void mints fused into
one mark alone on the canvas, every edge outlined. That takes about 333,000 mints.

- At normal volume: **~105 days** per gene.
- At peak volume every day: **~16 days**.
- Cost to make: about 280 ETH (100 ETH inside it, ~180 ETH of mining).

When it's done, holders face the PunkStrategy-sized decision on a Shapes-sized scale:

- **Sell it.** At cost × 1.2 that's ~337 ETH, and the ~56 ETH profit buys and burns PURE in one go.
- **Burn it.** 100 ETH goes to the dead address and the first pure Black Shape exists. Nothing comes
  back, and the sacrifice is the point.

A simple version lets PURE holders vote. A spicier version lets the forge sell a time-limited option:
if nobody buys it at the list price within 30 days, it gets burned.

The Great Work can run for each gene separately. Void and Solid are the headline pieces. Rich and
Faint (7% odds) finish about twice as fast.

---

## 6. The cheaper way to find Mythics: a standing bid

Mining costs ~0.018 ETH per Mythic because 94% of mints are thrown back. Instead, the forge can post a
standing offer: *"I'll buy any Void or Solid 0.01 Shape for 0.014 ETH."*

- Anyone who mints and gets a Mythic can sell it to the forge right away.
- The forge's cost per Mythic drops from 0.018 to 0.014, and every finished piece gets about 50%
  cheaper to make (a pure 1 ETH costs 1.4 ETH instead of 2.8).
- It brings the Shapes minting crowd into the machine. Every Mythic anyone mints has a guaranteed
  buyer.

The catch: minting 0.01 Shapes costs 0.011, so an honest minter still loses a little on average even
with this bid. The sellers who actually profit are people who **grind**: they submit mints that cancel
themselves unless the result is Mythic, paying only gas on the failures. The Shapes spec already
accepts grinding as possible, but it means the artist is paid the mint fee on 1 mint instead of ~17.
Whether the forge should pay grinders is a real trade-off between making pure pieces cheaper and
the fee income Shapes gets from honest mining. The forge could also run both, splitting its budget
between mining and bidding.

---

## 7. Why this is better than a straight PunkStrategy clone

| | PunkStrategy | The Forge |
|---|---|---|
| Where the profit comes from | reselling a Punk above the price paid | selling a made-to-order pure piece above its making cost |
| Worst case for inventory | Punk floor falls; the treasury loses | the piece cashes in for its ETH; only mining fees are lost |
| What the machine adds to the world | takes Punks off the market | creates new, rare, Complete pieces that didn't exist |
| The collection's cut | none directly | every mint pays the Shapes mint fee |
| Endgame | keep flipping | the Great Work, and a pure Black Shape |

---

## 8. What could break it

- **Demand for pure pieces is untested.** PunkStrategy sells into a deep Punk market. Nobody has
  priced a pure Void 1 ETH Shape yet. If collectors won't pay ~3.4 ETH for one, pieces slide back
  toward their ETH value and the burn loop slows. Start the forge on small pieces (0.05–0.5) to find
  the price, and let the markup be tunable.
- **Grinders compete.** If grinders flood the market with cheap Mythics, pure pieces get easier for
  anyone to make, and the forge's premium shrinks. The standing bid turns that competitor into a
  supplier.
- **The Shapes admin can raise the mint fee** up to 0.01 ETH per mint. That would multiply the
  forge's mining cost by about 9×. Whoever controls that admin controls this machine's economics.
- **Gas.** Mining is ~84k gas per mint. At 10 gwei, gas matches the mint fee and mining cost roughly
  doubles.
- **Parked ETH.** Mythics hold their 0.01 each until their piece sells. A slow sales market ties up
  mining money.

---

## 9. Open decisions

1. **Mine, bid, or both?** And how that trades pure-piece cost against Shapes' fee income.
2. **Mythic only, or Rares too?** Adding Faint and Rich doubles the product line and halves the time
   to a Great Work in those genes.
3. **Markup.** A fixed 1.2× like PunkStrategy, or an auction per piece with cost × 1.2 as the
   reserve.
4. **The Great Work's fate.** Holder vote, sell-or-burn deadline, or always burn.
5. **Fee.** 10% like PunkStrategy, with an 8/1/1 split.
