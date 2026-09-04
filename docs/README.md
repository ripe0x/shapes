# Design documents

The specs and drafts behind each feature, kept as written. Their status lines are historical;
`project/STATE.md` is the current status. Source comments cite these files by bare filename.

| File | What it decides | Status |
|---|---|---|
| [SHAPES_V2_SPEC.md](SHAPES_V2_SPEC.md) | Composition, provenance, Black Shape; the priority order the charter still binds to | implemented |
| [DECOMPOSE_SPEC.md](DECOMPOSE_SPEC.md) | The recomposition vocabulary (compose, decompose, split) and reversible compose | implemented |
| [SAMPLING_SPEC.md](SAMPLING_SPEC.md) | Geometry sampling: a composed or split token's modules come from its inputs' modules | implemented |
| [TRAIT_SPEC.md](TRAIT_SPEC.md) | Rarity traits added to `tokenURI`, all renderer-only and parity-critical | implemented |
| [INK_GENES_DRAFT.md](INK_GENES_DRAFT.md) | Ink gene design: a seven-state solidity trait set at mint and inherited through composition | implemented |
| [INK_GENES_IMPL_SPEC.md](INK_GENES_IMPL_SPEC.md) | Ink gene implementation spec: formulas, file-by-file changes, tests | implemented |
| [ZERO_AUCTION_DRAFT.md](ZERO_AUCTION_DRAFT.md) | Token 0 and the auction house denominated in Shape cards; predates the owner-token and architecture passes, see its section 6 | implemented |
| [WEBSITE_DESIGN_PROMPT.md](WEBSITE_DESIGN_PROMPT.md) | Design brief for the mint and gallery site | brief |
| [REVIEW_PROMPT_INK_GENES.md](REVIEW_PROMPT_INK_GENES.md) | Fresh-eyes review prompt for the ink gene implementation | brief |

The canonical references stay at the repository root: `SPEC.md` (rendering decisions),
`SECURITY.md` (threat model), `BUILDING.md` (integration), `METADATA.md` (traits).
`project/ARCHITECTURE.md` is the current system design.
