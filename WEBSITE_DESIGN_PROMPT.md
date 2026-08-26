# Design prompt — Shapes minting and gallery website

## What Shapes is

Shapes is an ERC721 token that wraps an exact amount of ETH. Mint a Shape by sending ETH; burn it and the same ETH comes back. Not a share of a pool — the same amount, exactly. Between mint and burn it is an ordinary NFT: transfer it, sell it, hold it.

There are exactly nine denominations, permanent: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH. Every other amount is rejected. The mint fee is 1% of the backing, paid on top. Redemption always returns the full backing.

The artwork is fully onchain SVG. Black background, white marks, nothing else — no color, no gradients, no text on the face. Each card is a 2.5 × 3.5 trading-card proportion (250 × 350 viewBox). The marks are simple geometric primitives — circle, square, triangle, half circle, quarter circle, diamond, half square, right triangle, arc, line — placed on a grid. Value controls density, inverted: a 0.01 ETH Shape is a dense 5 × 5 grid of 25 marks; a 100 ETH Shape is a single mark alone on a black field. The more ETH a Shape holds, the less is drawn.

Shapes is meant as an Ethereum primitive. The website should feel like one.

## What the website does

Two jobs: mint and browse. Nothing else.

### Pages

**1. Home / Mint.** One page. A short statement of what a Shape is, the nine denominations, and a mint action.

- The denomination picker is the centerpiece. Nine choices, laid out plainly — consider showing each denomination's grid dimensions (5×5 down to 1×1) as part of the picker, since the grid *is* the denomination's identity.
- Selecting a denomination shows the exact cost: backing + 1% fee = total. All three numbers, no rounding, no "approximately."
- A quantity control for batch minting is fine, but keep it quiet.
- The freshly minted Shape's artwork is shown after mint. That is the payoff; give it room.
- Wallet connection is a small, plain control. Not a hero button.

**2. Gallery.** A grid of live Shapes, newest first. Each card shows only the artwork — the art carries no text on its face by design, so the grid should read as a wall of black cards. Denomination and token number appear on hover or beneath the card in small type, or only on the detail page. Filter by denomination is the one filter that matters.

**3. Token detail.** One Shape, large. The artwork at generous size, then, below or beside it, in plain rows:

- Denomination (the ETH it holds — this is the fact that matters most)
- Token number and seed
- Current owner
- History: minted, transferred, redeemed — plain event rows with dates
- If the connected wallet owns it: a redeem action. The copy states plainly what happens: "Burn this Shape. Receive 1 ETH." Redemption is irreversible; the confirmation should say so in one sentence, not a modal essay.

**4. About / How it works.** Can be a section of the home page rather than a page. Short. The README's opening already has the right voice: "ETH in, Shape out. Shape burned, the same ETH out." Cover: the nine denominations, the 1% mint fee, redemption, that the contract holds the ETH and does nothing else with it, that the art is fully onchain, and what the owner cannot do (no pause, no withdrawal, no fee change). A link to the contract address and source.

## Visual direction

The site takes its language from the artwork, but does not compete with it.

- **Monochrome.** Black, white, and grays only. No accent color. The artwork is white-on-black; the site around it can be either polarity — a near-white page that makes the black cards read as objects, or a black page where the cards sit flush. Pick one and commit. Consider offering both via a plain light/dark toggle, but design one as primary.
- **Generous whitespace.** The art is mostly empty space; the site should be too. Wide margins, few elements per view, one idea per screen section. When in doubt, remove.
- **Grid discipline.** The artworks live on strict grids. The page layout should visibly share that discipline — aligned columns, consistent gutters, cards at exact 2.5:3.5 proportion always. Never crop, round the corners of, or shadow the artwork. The card is the card.
- **Typography.** One typeface, or one plus a mono for numbers and addresses. Something plain and neutral — a grotesque or a system stack. Sizes step down cleanly; small caps and decorative weights are out. ETH amounts, seeds, and addresses in mono. Numbers are content on this site; set them carefully.
- **No decoration.** No gradients, no glassmorphism, no glows, no rounded blobs, no illustrations, no icons where a word works. Borders are 1px solid or absent. The primitives in the artwork are the only shapes on the site.
- **Motion.** Minimal. Fine: a quiet fade-in for artwork as it loads. Not fine: parallax, hover tilts, animated backgrounds, scroll-jacking.
- **Buttons and controls.** Rectangular, bordered or filled, plainly labeled: "Mint", "Redeem", "Connect". No arrows, no sparkles, no verbs like "unleash."

## Copy voice

This matters as much as the layout. Every sentence on the site follows these rules:

- Simple words, short sentences. If there is a simple way to say it, use it.
- State facts. Never persuade. No hyperbole, no superlatives, no "revolutionary," no "unlock," no exclamation points.
- Exact numbers, always. "1 ETH + 0.01 ETH fee = 1.01 ETH total." Never "~1 ETH" or "just 1%."
- Say what the contract does and does not do, plainly. "The contract holds the ETH. It does not lend it, stake it, or invest it."
- No urgency, no scarcity language, no countdowns.

Sample copy in the right register:

> A Shape holds ETH. Burn the Shape and the ETH comes back. The same amount, exactly.

> Nine denominations. 0.01 to 100 ETH. Higher value, fewer marks.

> Mint fee is 1% of the backing, paid once at mint. There is no burn fee.

> Burn this Shape. Receive 1 ETH. This cannot be undone.

## Functional notes

- Show exact wei-precise values where precision matters (redeem confirmations), formatted ETH elsewhere. Never round in a way that misstates cost.
- Transaction links go to evm.now (`https://evm.now/tx/<hash>?chainId=<chainId>`), not Etherscan.
- Failed transactions surface the decoded revert reason in plain language, not a raw error dump.
- Artwork comes from `tokenURI` — onchain SVG. Render it as delivered; the site never redraws or restyles it.
- The site should work fine with no wallet connected: browsing the gallery and reading how it works require nothing.

## What to avoid

- Marketplace tropes: floor price tickers, rarity scores, trending sections, activity feeds.
- Financial dashboard tropes: charts, APY, TVL framing. The reserve is a fact, not a metric to celebrate; if shown at all, one line: "The contract holds X ETH backing Y Shapes."
- NFT-site tropes: mint countdowns, progress bars toward a supply cap (there is no cap), roadmap sections, team sections, FAQ accordions with fifteen entries.
- Any element that would look wrong printed in black and white. Everything here should.
