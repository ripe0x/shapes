# Review Prompt — Shapes

*Paste this together with `PROJECT_OVERVIEW.md`. It asks for a critical, unbiased read.*

---

You are an independent reviewer. I built the protocol described in the attached document
(`PROJECT_OVERVIEW.md`) and I want your honest, unbiased assessment of the **idea** — not a
security audit, and not encouragement.

Read the whole document first. Then give me a critical evaluation. I am not looking for
validation. If the core idea is derivative, or the value is thin, or the positioning is wrong,
say so plainly and explain why. If a specific mechanic is clever, say that too — but only where
you actually believe it, and say what it trades away. Treat "this is interesting" as a claim you
have to earn, not a courtesy.

A few ground rules so the feedback is useful:

- **No sycophancy.** Do not open with praise. Do not soften every criticism with a compliment.
  If your honest read is "mixed," lead with the sharpest objection.
- **Argue against it first.** Before you tell me what works, spend real effort on the strongest
  case that this should not exist, or that no one needs it. Then tell me whether that case holds.
- **Be concrete.** Name comparable projects, prior art, and market categories by name. "Similar
  to X but differs in Y" is worth more than adjectives.
- **Separate the layers.** The backing primitive, the provenance/composition system, and the
  ink-gene trait game are three distinct bets. Judge each on its own, then judge whether they
  belong together. It is a valid conclusion that one layer is strong and another is dead weight.

Evaluate along these axes explicitly, each as its own section:

1. **The core idea.** Is "an ERC721 that wraps an exact, redeemable amount of ETH, with the
   denomination driving the artwork's density" a genuinely good idea, or a gimmick? What is the
   actual insight, if any? Would it matter if it didn't exist?

2. **Novelty and prior art.** What has been done before that this resembles — wrapped-ETH
   tokens, NFT-bonds/redeemable NFTs, Checks-style composability, generative onchain art,
   fully-onchain collections? Where is Shapes genuinely new versus a recombination of known
   parts? Be specific about which project already did which piece.

3. **Use cases.** Beyond "collect it," what is it *for*? As a composable primitive — collateral,
   escrow/gift instruments, denominated onchain cash, a building block for other contracts,
   game/reward machinery, treasury or savings tooling. Which of these are real and which are a
   stretch? What use case, if any, is compelling enough that someone would reach for Shapes
   specifically instead of plain ETH or an existing wrapper?

4. **Value — to whom, and why.** Who holds this and why: collectors, DeFi users, artists,
   protocols integrating it, speculators? What is the value proposition to each, and is any of
   it durable versus a novelty that fades after mint? Where does value actually accrue, given
   there is no yield, no fee capture beyond a one-time 1% mint fee, and no treasury?

5. **Conceptual / artistic value as an onchain system.** Is the concept coherent as *art* —
   value literally embodied as visual density, provenance as an unforgeable conserved quantity,
   a terminal "Black Shape" that burns 100 ETH for pure lore? Does the idea say something, or is
   the conceptual framing decoration on a financial toy? Compare against onchain-art lineages
   (Autoglyphs, Art Blocks, Checks, Terraforms, etc.) on *ideas*, not just aesthetics.

6. **Market positioning — as a primitive, not just as art.** Where does this sit in the crypto
   market? Is there a real niche between "NFT art project" and "DeFi primitive," and does Shapes
   occupy it or fall between two stools? Who would integrate or build on it, and what would have
   to be true for that to happen? Is "independent primitive that makes sense even if nothing is
   built on top of it" a strength or a fatal go-to-market weakness? What would kill it —
   indifference, a simpler competitor, a regulatory framing (is a redeemable ETH-wrapper a
   deposit/e-money problem)?

Close with a single blunt verdict: if you had to bet, does this deserve to exist and find an
audience, or not — and what is the one change that would most improve its odds. If your answer
is "no," say no.

One framing note, not a thesis to argue for me: the document mentions in passing that a
gacha/`fwa.fun`-style machine could use Shapes as prize tokens. That is one downstream
integration among many, not the point of the project. Do not let it dominate your read — weigh
it only as much as any other single use case, and push back if you think even that weight is too
much.
