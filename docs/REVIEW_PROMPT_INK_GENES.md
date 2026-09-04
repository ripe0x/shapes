# Review Prompt — Ink Genes Implementation + Path to Deploy

Paste this whole document as the opening prompt of a fresh session. You are a fresh set of
eyes: nothing below is trusted until you verify it yourself.

---

You are reviewing the Shapes repo (`~/CascadeProjects/shapes`), an ERC721 that wraps exact
ETH denominations (0.01–100, nine steps) with fully on-chain generative art. Core protocol:
`mint`/`redeem` (ETH in/out), `compose`/`decompose`/`split` (reshape without moving ETH),
`burnBacking` (turn a complete 100-ETH apex Black without burning its NFT). Economic admin is
absent; the transferable admin controls independently lockable renderer, positions and market
pointers. Read `SPEC.md` and `SECURITY.md` first — they carry the project's
decision records (D1–D17) and threat model.

## What just happened (verify, don't trust)

A previous session designed and implemented an "ink gene" trait system. Relevant commits on
`main`:

- `0e94b69` — INK_GENES_DRAFT.md (design rationale) + INK_GENES_IMPL_SPEC.md (impl spec)
- `a333b1b` — the implementation (20 files: `src/lib/InkGenes.sol`, changes through
  `Shapes.sol`, `ShapeRenderer.sol`, interfaces, `preview/src/canonical/ink.ts`, tests,
  fixtures, docs)

Design in one paragraph: each token carries a seven-state gene (Void→Solid) set once at
mint from its seed — dust (0.01) rolls the full lottery with 3% extremes, larger direct
mints roll only Sparse/Murk/Dense — and thereafter the gene changes only in `compose`,
which walks one deterministic roll per denomination tier crossed (70% toward the
units-weighted center of the pool, 20% toward the best gene present, 10% toward the worst),
keyed by `keccak(survivorSeed, XOR(burnSeeds), newIndex)`. Split copies the gene and decompose restores it
verbatim. The renderer consumes-and-discards the old card-level fill draw (stream
alignment, D5) and paints `GENE_PROBABILITY[gene]`. Design goals it must satisfy: entropy
at mint only; everything downstream deterministic and previewable (`simulateCompose`);
attempts consume seeds/fees, never just gas; burn-order must not affect outcomes but
survivor choice must; rare traits survive by odds, not perfection of all inputs.

The implementation was written by a smaller model from the impl spec and reviewed once.
All verification so far ran in a cloud container, NOT on this machine.

## Task 1 — Independent verification (do this first)

1. `forge test` — expect 178 passed, 0 failed, 4 skipped (Fork tests skip without
   `MAINNET_RPC_URL`). Also `forge test --mc Parity`.
2. `cd preview && npm ci && npm run fixtures && npm run sweep` — fixtures must regenerate
   byte-identically (git diff clean afterward; 78 fixtures) and the sweep must pass.
3. `cd preview && npx tsc --noEmit && npm run build` (or the repo's equivalent) — the
   previous review did NOT verify the Vite app builds; `render.ts`'s signature changed
   (`inkGene` now required) and app/site components (`preview/src/app/*`,
   `preview/src/site/*`) may have stale call sites the sweep doesn't touch.
4. CI: check `.github/workflows/ci.yml` still reflects reality (foundry version, node
   steps, fixture regeneration). Run whatever CI runs.

## Task 2 — Adversarial review of the ink gene mechanic

Review as an attacker and as an auditor. Named checks:

- **Encoding parity**: `InkGenes.sol` vs `preview/src/canonical/ink.ts` — same domain
  strings ("ink:mint", "ink:compose"), same `abi.encodePacked` types
  (string/bytes32/uint256/uint8), same thresholds, same center rounding
  `(2*sumW + U)/(2*U)`. The parity tests assert this; confirm the tests actually cover
  every branch (all seven mint genes both tiers, walk at T=1 and T=8).
- **Order invariance**: XOR fold — confirm no code path lets `burnIds` order, duplicates,
  or calldata layout affect the gene. Check `simulateCompose`'s explicit duplicate
  rejection matches `compose`'s implicit one (burn-of-burned reverts).
- **No fresh entropy**: grep the gene paths for any block data, msg.sender, or state that
  isn't (seed, gene, denomIndex). The walk must be a pure function.
- **Reroll surfaces**: try to construct any sequence (compose/decompose/split/redeem/
  re-mint) that rerolls a gene without paying a mint fee for fresh seeds. Decompose
  children derive seeds from the parent — confirm the reachable outcome tree really is
  finite and deterministic.
- **Split soundness**: all children of a split must share the parent gene. Try to break it through
  transfer, nested splits and later composition.
- **Storage**: `ShapeData` still packs into two slots with `inkGene` added. Check with
  `forge inspect Shapes storage-layout`.
- **Renderer**: D5 compliance — the discarded fill draw is still consumed in BOTH
  renderers; module streams identical to pre-ink for the same seed apart from solid flags.
  `isBlack` precedence unchanged. "Ink" trait JSON well-formed.
- **Events**: `InkGene` emitted on every gene assignment (mint, compose, split children and
  revived decompose inputs) — enough for an indexer to track genes with no state reads.
- **Walk math edge cases**: gene bounds (can g step outside 0..6? targets are genes, so
  no — verify), center division (units can never be 0), T=0 impossible (compose total
  strictly grows), uint8 arithmetic.

Report findings with severity; fix what you find (tests first), keeping the impl spec's
rules: TS canonical is source of truth, InkGenes.sol is a byte-exact port, fixtures
regenerate, parity green.

## Task 3 — Known open items (from the previous session, in priority order)

1. **Monte Carlo tuning (required before freeze).** The ⚙ constants are STRAWMEN: mint
   distributions (3/7/15/50/15/7/3 dust; 20/60/20 non-dust), walk odds (70/20/10), gene→
   probability table. Build a simulation in `preview/` that models real players — who
   preview every candidate set off-chain, exploit survivor choice (~n+1 shots per set),
   and only execute winners — and tune against a headline target like "a Solid 100 takes
   roughly X ETH parked and Y dust mints of hunting." Present the tradeoff curves to the maintainer
   for the final call; constants are immutable after deploy.
2. **Epoch commit-reveal decision (draft §6 of INK_GENES_DRAFT.md).** Currently seeds are
   grindable at ~1 revert-attempt/block (accepted risk D3e). With genes, grinding dust
   jackpots is gas-priced rather than fee-priced. Checks' scheme (mint first, reveal
   blockhash+50 later, anyone can reveal) closes it. Present the tradeoff (50-block
   unrevealed window, contract surface) to the maintainer; implement only if he says yes.
3. **Mega-compose gas note.** A single-tx 10,000-dust → 100 compose costs ~70.8M gas —
   over any block limit. Pre-existing O(n) burn loop, fine for the game (ladder through
   intermediate composes), but record it in SPEC.md so nobody designs around one-tx apexes.
4. **Burn-backing lore (open, cosmetic).** Should `burnBacking` record the gene the apex died with
   (a Solid Black vs a Void Black), even though isBlack overrides rendering? Zero protocol
   cost. Ask the maintainer; one-line change + trait if yes.
5. **Stale numbers/docs.** INK_GENES_IMPL_SPEC.md §5 says "66 fixtures"; the harness has
   produced 78 since before ink genes — correct the doc. Check README.md (22KB) and
   WEBSITE_DESIGN_PROMPT.md for anything describing the old fill-band behavior or the
   deleted `inkDemo.ts`; update descriptions of traits to include Ink.
6. **Preview/site UX (nice-to-have).** The preview app and site views don't surface genes
   yet beyond compiling. Consider: gene readout in Inspect, a simulateCompose planner in
   the chain app. Ask the maintainer before building.

## Task 4 — Cleanup

- `_to_delete/` at repo root holds the removed `inkDemo.ts` and stray git lock files (a
  prior session couldn't delete on this machine). Delete the folder.
- `.claude/settings.local.json` is untracked — leave or gitignore, the maintainer's call.
- Commits `0e94b69`/`a333b1b` are LOCAL ONLY. Push to `origin/main`
  (github.com/ripe0x/shapes) after Task 1 passes locally.
- If any `.git/*.lock` files reappear and block git, they're leftovers — remove them.

## Task 5 — Deploy readiness checklist

Work through, reporting status on each; do irreversible things only with the maintainer's explicit
go:

1. All of Task 1 green locally + CI green on push.
2. Fork tests: run `forge test` with `MAINNET_RPC_URL` set so the 4 skipped tests execute.
3. Refresh `audits/AUDIT_PROMPT_v2.md` to cover ink genes (new attack surface: gene walk,
   simulate views, InkGene event) and run a full audit pass against it — at minimum a
   thorough self-audit; recommend an external reviewer before mainnet given immutability.
4. Constructor arguments decided and double-checked: immutable `mintFee` (currently committed to
   0.001 ETH per mainnet Shape), initial `feeRecipient` (prefer an EOA or audited non-reverting
   receiver), and admin. A reverting
   recipient blocks minting until admin redirects future fees; renouncing admin freezes the final
   recipient (SECURITY.md). Renderer address deployed first and verified.
5. `script/DeployShapes.s.sol` + `script/e2e-anvil.sh` run clean end-to-end on anvil,
   including a tokenURI smoke check showing the Ink trait.
6. Testnet (sepolia) deploy + manual walkthrough: mint dust, mint 1 ETH, compose with
   simulate-preview parity, decompose/split, redeem. Verify contracts on Etherscan.
7. Post-deploy policy decisions documented for the maintainer: final fee recipient,
   when/whether to `lockPresentation`, and when/whether to `renounceAdmin`. `lockPresentation`
   freezes the renderer, the collection and the metadata copy together. Admin also controls the
   independently lockable positions and market pointers.
8. Items 1–2 of Task 3 resolved (tuned constants, epoch decision) — these are the two
   blockers that must be settled BEFORE any deploy, since both are immutable.

## Ground rules

- Read `SPEC.md` before touching `preview/src/canonical/` or the renderers; re-run
  `forge test --mc Parity` and `npm run sweep` after any change there (project rule).
- Never batch-render from consecutive integer seeds (D3d). Seed entropy must contain
  nothing caller-controlled (D3e).
- The maintainer prefers short, bullet-driven, plain-language updates. Delegate mechanical work to
  cheaper models where sensible; keep judgment calls in the main thread. Ask before
  anything irreversible, and before building nice-to-haves.
