# A strategy coin that runs on Shapes (draft v0.1)

Status: speculative design for discussion. Nothing is built, and it needs no change to Shapes.
It replaces the earlier VOID and Forge drafts. The coin has no name yet.

---

## 1. The premise

The goal is lasting attention on the coin. Not on an NFT collection.

PunkStrategy used Punks for borrowed prestige at launch. What kept attention after that was the
coin's own machinery: fees, buys, burns. So the NFTs here don't need an audience of their own.
They need to do things a coin can't do by itself.

Shapes are good at exactly that, precisely because nobody needs to care about their art:

- **A Shape listed below the ETH inside it always sells.** Anyone can buy it and cash it in for a
  guaranteed profit, so a sale can be triggered on demand. That turns fees into buy-and-burn events
  on a schedule.
- **A Shape is a prize that is exactly its ETH.** It's provable, collectible, and cashes in anytime.
- **A 100 ETH Shape can be burned into a Black Shape.** Destroying 100 ETH in public, provably, is a
  spectacle nothing else offers.

The coin is the game. Shapes are the machinery.

---

## 2. What holds attention on a coin

1. **Price action people can anticipate.**
2. **Events with stakes, on a rhythm.**
3. **Something to do,** not just something to hold.
4. **A story worth repeating.**
5. **New money arriving.**

Every piece below serves at least one of these.

---

## 3. The machine at a glance

```
          trades (fee in ETH, 4–10%, set by volume)
                          │
         ┌────────────────┼────────────────┐
        75%              20%               5%
       LANES            RAFFLES          KEEPERS
         │                │               (rewards for
   0.5 / 5 / 100 ETH   prize Shape        triggering
   progress bars       grows until full    each step)
         │                │
   Shape listed        people burn coins
   just below its ETH  to enter; random
   → a bot buys it     end in the final hour
   → the machine buys  → winner gets the Shape
     the coin, burns it
         │
   the 100 ETH lane is the finale:
   holders choose a 100 ETH buy-and-burn,
   or burning it into a Black Shape
```

Coins are destroyed in three places: every lane sale, every raffle entry, and the losing side of
each finale vote.

---

## 4. The token and the pool

- **Supply:** 1 billion, all placed in the pool at launch. No team allocation; if you want a team
  cut, take it as a small slice of fees instead.
- **Pool:** a Uniswap v4 pool, ETH against the coin. A hook owns all the liquidity, so nobody can
  pull it, and runs the fee.
- **Plain coin:** no transfer tax or special rules, so every wallet and trading app handles it
  normally.
- **Launch:** fees start at 95% and fall to the normal range over the first hour, so snipers pay
  for the first lanes.

### The fee follows volume

A flat 10% kills trading on quiet days. The fee is set by the last 24 hours of volume:

| Last 24h volume | Fee |
|---|---|
| under $50k | 4% |
| $50k–$500k | rises in step with volume |
| over $500k | 10% |

Quiet markets get cheap, which invites traders back. Busy markets pay full price, when traders care
least. The fee is taken in ETH on both buys and sells.

---

## 5. Lanes: scheduled buy-and-burns

75% of fees go to three lanes. Each lane fills toward one Shape size, and everyone can watch every
lane fill.

| Lane | Share of lane money | What it is |
|---|---|---|
| 0.5 ETH | 40% | the steady drip |
| 5 ETH | 35% | regular events |
| 100 ETH | 25% | the finale (section 7) |

### When a lane fills

1. The machine mints a Shape of that size.
2. It lists the Shape at slightly above the ETH inside, and the price falls steadily for about two
   hours, ending slightly below.
3. As soon as the price dips under the Shape's ETH, a bot buys it, because it can cash it in at a
   profit. The profit is tiny, so almost all the fee money becomes a burn.
4. The machine uses the sale money to buy the coin and burns it. It splits big buys across several
   blocks so bots can't cheaply trade in front of them.

Because the listing's price falls on a known schedule, every burn is predictable: "the 5 ETH burn
lands in about 40 minutes." Traders buy ahead of it, and that trading is part of the point.

### Show the lanes in trading volume too

Each lane also shows how much more trading fills it: "$42k more trading fires the 5 ETH burn."
Communities rally to push it over the line.

### Backstop

If the 5 ETH lane hasn't fired in 90 days, its money moves down into the 0.5 ETH lane, so a dead
market still gets burns. The 100 ETH lane never moves down: it's the legend.

---

## 6. Raffles: burn to win a Shape

20% of fees go to a raffle prize. People enter by burning coins, and one winner takes the Shape.

### How a raffle runs

1. **The prize grows.** A Shape in the machine grows as fees arrive, merging up the Shapes sizes, so
   anyone can see exactly what it's worth.
2. **People enter by burning.** Buy the coin and burn it in one step on the site, or burn coins you
   already hold. More burned means better odds.
3. **Early entries count more.** Burning while the prize is still small counts up to double. That
   rewards committing early and spreads entries across the round.
4. **The final hour.** When the prize reaches its target size, one last hour starts. Afterwards, a
   random moment inside that hour is picked as the real end; only entries before it count. Later
   entries roll into the next raffle. Nobody knows the cutoff, so entering at the last second
   doesn't help.
5. **The draw.** One winner, picked at random with odds by amount burned, gets the Shape. They can
   keep it or cash it in for the exact ETH inside.

### The prize size follows the market

Raffles aim for a size on the Shapes ladder (0.1, 0.5, 1, 5, 10 ETH). If a raffle filled in under 8
hours, the next one aims one size bigger. If it took over 2 days, one size smaller. So raffles
settle somewhere between every 8 hours and every 2 days, and prizes grow when the coin is hot.

### Why it works

Players tend to collectively burn close to the prize's value, so each raffle burns roughly as many
coins as a sale of that prize would have. It also gives people something to do, and a story every
time: "someone won a 5 ETH Shape for 0.2 ETH of coins."

---

## 7. The finale: 100 ETH, burned or bought back

The 100 ETH lane is special. Only a 100 ETH Shape built from 10,000 separate 0.01 ETH mints can be
burned into a Black Shape. So this lane mints 0.01 Shapes as it fills and merges them up. That
costs about 10% extra in Shapes mint fees, about 113.5 ETH all-in.

When it's full, a 72-hour vote opens:

- **BUY BACK:** list it below its ETH like any lane, and put 100 ETH into buying and burning the
  coin at once. It's the biggest candle the coin will ever print.
- **BURN:** burn its 100 ETH into a Black Shape. The ETH is gone forever, the Black Shape goes to
  one voter on the winning side, drawn at random by stake, and the tweet writes itself.

Voting works by staking coins on a side:

- **Hours 0–48:** stake freely; pulling out costs 20% of your stake, burned.
- **Hours 48–72:** no withdrawals. The real end is a random moment in this window, picked afterward.
- **Result:** the side with more stake at the real end wins. **Every coin staked on the losing side
  is burned.**

The vote is a tug-of-war with sunk costs and a surprise ending, so it tends to escalate, and every
escalation on the losing side is destroyed.

---

## 8. Optional: Shapes mint fees as outside money

Every loop above runs on the coin's own trading. The one way to add genuinely outside money: Shapes'
admin points Shapes' mint fees at the machine, so every Shape minted anywhere feeds the lanes. The
machine's own minting then pays itself back too.

The trade-off: it redirects the artist's mint income into the coin. How much it adds depends on how
much Shapes gets minted.

---

## 9. What it produces at your volume

Assumptions: ETH ≈ $3,500. A normal day is $150k of trading (about 43 ETH, fee ≈ 5.3%). A peak day
is $1M (about 285 ETH, fee 10%).

| | Normal day | Peak day |
|---|---|---|
| Fees | ~2.3 ETH | ~28.5 ETH |
| 0.5 ETH burns | ~1–2 a day | ~17 a day |
| 5 ETH burns | every ~8 days | ~1–2 a day |
| Raffle | ~0.5 ETH prize, about daily | ~5 ETH prize, about daily |
| 100 ETH finale | ~9 months at normal pace alone | ~3 weeks at peak pace alone |

In practice the finale lands somewhere between those, depending on how many hot stretches the coin
has. It's meant to be rare.

---

## 10. How it's built

- **Hook (Uniswap v4):** owns all liquidity, sets the fee from 24h volume, takes fees in ETH on both
  sides, and splits them into lanes, raffles and keepers. On a "buy and burn to enter" swap, it
  burns the coins bought inside the same transaction and records the raffle entry.
- **Shapes vault:** holds lane and raffle Shapes. It is the only part that calls Shapes: mint,
  merge, and, for the finale, burn into a Black Shape.
- **Listings:** falling-price sales anyone can fill.
- **Keepers:** anyone can trigger each step (mint, list, buy-and-burn, draw) and gets paid from the
  5% keeper slice. No step depends on a trusted operator.
- **Randomness:** raffle end moments come from a block chosen in advance. The finale vote uses
  Chainlink VRF, because 100 ETH is too much to leave to a block producer's nudge.
- **No admin.** Nothing can be changed after launch.

---

## 11. Honest limits

- **It still runs on attention.** The machine makes every wave of interest burn as much as
  possible, and gives people reasons to come back, but it can't create interest from nothing.
- **No borrowed launch story.** Without a famous collection, the coin has to earn its first wave
  itself. "They burn 100 ETH" is the hook.
- **Front-running is by design.** Predictable burns get traded around. That trading pays fees, but
  some holders will see it as bots taking a cut.
- **Shapes' admin controls the mint fee.** Raising it up to its cap of 0.01 ETH would make the
  finale's lane roughly twice as expensive.
- **Gas.** Building the 100 ETH Shape takes about 3.5 billion gas in total, roughly 3.5 ETH at
  1 gwei. At higher gas prices it costs more.

---

## 12. Open decisions

1. **Fee band.** 4–10% by volume, or a flatter range.
2. **Split.** 75/20/5 between lanes, raffles and keepers, and whether you take a team cut.
3. **Lane sizes and shares.** 0.5 / 5 / 100 ETH at 40/35/25.
4. **The finale's default.** If nobody votes, buy back or burn.
5. **Shapes mint fees into the machine,** or not.
