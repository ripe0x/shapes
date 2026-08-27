# EXP-001 — Mainnet gas ceilings

- Id / date / decision served: EXP-001, 2026-08-27, D-08 and W-2
- Hypothesis: a 10,000-origin apex is impossible as one 9,999-input operation, but practical as a sequence of legal, bounded compositions under a 30,000,000-gas Ethereum L1 block ceiling.
- Method:

  ```sh
  forge test --match-contract GasCeilingsTest -vv
  forge test --match-contract InkGeneComposeTest --match-test test_ComposeMegaGasProfile_10000Dust -vv
  ```

  Forge 1.5.0, solc 0.8.28, default mainnet ladder, `via_ir = true`, optimizer runs 100. `test/GasCeilings.t.sol` incorporates the preserved `origin/preserve/split-gas-measure` 10/100/500 split points.

- Results:

  | operation | measured gas | vs. 30M |
  | --- | ---: | ---: |
  | `mint(0.01)` / `redeem` | 207,133 / 23,639 | fits |
  | `mintBatch(10)` / `redeemBatch(10)` | 839,002 / 120,310 | fits |
  | bounded `compose` rungs 0→1 through 7→8 | 985,862 max | fits, 29.0M headroom |
  | bounded `decompose` rungs 0→1 through 7→8 | 309,800 max | fits |
  | `composeMany(10 × 5-to-1)` / `decomposeMany(...)` | 9,773,061 / 3,054,864 | fits for this measured batch |
  | `split` to 10 / 100 / 500 / 1,000 dust | 1,556,305 / 14,143,316 / 70,503,012 / 141,397,046 | 100 fits, 500+ do not |
  | one `splitTo(5)` | 865,016 | fits |
  | direct `compose(10,000 dust → 100 ETH)` | 1,133,751,468 | 37.8× over ceiling |
  | direct `split(100 ETH → 10,000 dust)` with 30M forwarded | fails | does not fit |
  | direct 10,000-input `decompose` with 30M forwarded | fails | does not fit |
  | `sacrifice` on a genuine apex Complete | 88,001 | fits |

  The legal tiered route has ratios `5,2,5,2,5,2,5,2`, so it is exactly `2,000 + 1,000 + 200 + 100 + 20 + 10 + 2 + 1 = 3,333` compositions. `test_Tiered10000DustApexUses3333BoundedComposes` executes that exact tree and asserts the final token is a 100 ETH Complete with origin count 10,000. This is a call-count and correctness result, not a transaction-count claim: `composeMany` can batch calls. The only measured batching evidence is the 10-call, 5-to-1 `composeMany` sample above; do not extrapolate it to a safe full-tree batch size.

- Conclusion: supported. Direct fan-in/fan-out at 10,000 is unusable on Ethereum L1. The hierarchical tree is valid and every individually measured rung fits, while the only measured batched sample also fits. A safe production batch size for the full tree remains unmeasured.
- Decision impact: D-08 should document the bounded route and explicitly reject any UX that offers direct 10,000-input compose/split/decompose. W-2 adds no new evidence: `preview/scripts/simulate.ts` already has a local-only apex scenario, and its 1,000-input batches are themselves not L1-feasible. Do not add another simulation; use this harness as the authoritative feasibility evidence.
- Follow-ups: measure a production UI batch-size recommendation only after choosing a target chain and a safety margin. The 500-child split result is a stop condition for any feature that requires broad arbitrary dust fan-out in one L1 transaction.
