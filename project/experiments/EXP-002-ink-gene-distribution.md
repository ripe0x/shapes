# EXP-002 — Ink-gene distribution and Solid-100 difficulty

- Id / date / decision served: EXP-002, 2026-08-27, D-07
- Hypothesis: the committed dust distribution `[3,7,15,50,15,7,3]`, non-dust band `[20,60,20]`, and walk `[70,20,10]` make a Solid 100 materially difficult to grind.
- Method:

  ```sh
  npm ci --ignore-scripts
  npm --prefix preview run ink:tune
  # Optional precision control, minimum 2:
  INK_FACTORY_TRIALS=64 npm --prefix preview run ink:tune
  ```

  `preview/scripts/inkTuning.ts` first proves its parametric implementation matches the committed canonical `ink.ts` over 4,000 deterministic vectors. It then runs 20,000 deterministic samples for every rescue-cell probability, 30,000 for each walk sensitivity point, and 64 independent outcomes for each retained-gene heuristic at every composable denomination. RNG seed is `12345`; raw deterministic curves are written to `preview/scripts/out/ink-tuning.json`. The heuristic redeems sub-threshold dust, retains Dense-or-higher or Rich-or-higher tokens, and searches the legal survivor choices. Every retained token carries its actual mint seed; a selected survivor keeps that seed at the next level and each candidate uses the XOR of its actual burn seeds. It is not an optimizer and does not establish a global minimum cost.

- Results:

  | target | Dense-retention heuristic mean dust mints, n=64 | homogeneous Solid-dust baseline |
  | --- | ---: | ---: |
  | 0.05 ETH | 98 | 167 |
  | 0.1 ETH | 145 | 333 |
  | 0.5 ETH | 472 | 1,667 |
  | 1 ETH | 650 | 3,333 |
  | 5 ETH | 2,219 | 16,667 |
  | 10 ETH | 4,047 | 33,333 |
  | 50 ETH | 20,051 | 166,667 |
  | 100 ETH | **40,064** | **333,333** |

  The exact homogeneous baseline also covers direct dust at 0.01 ETH: 33.3 expected mints. Its 100 ETH result costs 33.33 ETH in 1% mint fees and parks about 100 ETH. The seed-aware retained-Dense heuristic result for Solid 100 is 40,064 dust mints, 95% CI **39,972–40,156**, p50 40,064, p95 40,640, and about **4.01 ETH** in mint fees. The measured peak retained backing is **100.07 ETH mean**, p95 **100.15 ETH**, min 100.00 ETH, max 100.17 ETH.

  The 20,000-sample single-rung rescue rates show why the full ladder must be measured instead of extrapolating from homogeneous pools: with four Solid plus one Murk child, a 0.01→0.05 group reaches Solid 58.5%; four Solid plus one Dense reaches Solid 99.98%. Across the ladder, the retained-Dense heuristic costs less than the retained-Rich heuristic at 100 ETH (40.1k versus 100.1k expected dust mints).

- Conclusion: refuted for the seed-aware measured heuristic. The current constants allow this retained-Dense policy to reach Solid 100 for about 4 ETH in fees, rather than the 33 ETH homogeneous baseline. This does not establish the globally cheapest strategy. No product constant was changed.
- Decision impact: D-07 should be **reconsider constants before P2**, with a Director decision on the intended target cost for a Solid 100. The evidence does not select a replacement distribution or walk vector, so changing any constant now would be an unsupported product decision.
- Follow-ups: once the desired fee/mint-cost range is chosen, sweep both dust distribution and walk odds against this retained-intermediate policy, then rerun this exact harness before freezing constants.
