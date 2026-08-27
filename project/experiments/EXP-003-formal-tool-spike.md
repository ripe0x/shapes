# EXP-003 — Formal-tool adoption spike

- Id / date / decision served: EXP-003, 2026-08-27, D-09
- Hypothesis: an additional symbolic or stateful property-testing tool can exercise the reserve/lifecycle invariants with bounded CI cost beyond Foundry’s existing fuzz and invariant suites.
- Method:

  ```sh
  # Halmos, installed only in /tmp/shapes-p1-halmos with Python 3.12
  /tmp/shapes-p1-halmos/bin/halmos --contract HalmosReserveTest \
    --function check_MintThenRedeemRestoresExactReserve --solver z3 \
    --solver-timeout-assertion 30s --no-status -vv

  # Medusa needs its configuration at the project root for crytic-compile. The link is temporary.
  ln -s project/experiments/medusa-reserve.json medusa.json
  /tmp/shapes-p1-medusa/medusa fuzz --config medusa.json --timeout 120 --test-limit 20000
  unlink medusa.json
  ```

  Versions: Halmos 0.3.3, Medusa 1.5.1, crytic-compile 0.3.11, Forge 1.5.0, solc 0.8.28. The Medusa harness has only bounded valid lifecycle actions: initialize, mint dust, compose 5 dust, split a nickel, decompose, and redeem. Its two `property_` methods check exact reserve equality and solvency after every generated call.

- Results:

  | tool | result | evidence |
  | --- | --- | --- |
  | Halmos | defer | The real `check_MintThenRedeemRestoresExactReserve` run did not reach symbolic execution within the three-minute spike budget. Its required `forge build --ast --extra-output storageLayout metadata` consumed about 2.1 GB RSS while compiling, so it was terminated at 3:01. This is a reproducible local resource blocker, not a proof failure. |
  | Medusa | adopt | After fixing two integration defects exposed by the spike, a four-worker run reached 27,227 calls in 3 seconds, 26 corpus entries, 715 branches, and passed 10/10 tests, including both reserve properties. LCOV is written under `/tmp/shapes-p1-medusa-corpus/coverage/lcov.info`. |

  The integration defects were: (1) Medusa’s crytic-compile adapter treats the configuration directory as the project root, so a config under `project/experiments/` must be linked at root for the invocation; (2) Medusa 1.5.1 panics in `CoverageTracer.SetInitialContractsSet` when `coverageEnabled` is false. The committed config keeps coverage enabled and uses an ephemeral `/tmp` corpus.

- Conclusion: hypothesis supported for Medusa, inconclusive for Halmos. Medusa adds a coverage-guided, mutation-based, multi-transaction campaign around E-1 reserve equality/solvency and the core mint/compose/split/decompose/redeem lifecycle. It is not a formal proof and does not replace Foundry invariants.
- Decision impact: adopt the bounded 20,000-transaction Medusa campaign in CI. `.github/workflows/ci.yml` pins Medusa 1.5.1 and crytic-compile 0.3.11, installs them per run, and removes the temporary config link on exit. Defer Halmos, with no CI job, until its AST-build memory/time cost can be reduced or a dedicated runner is approved.
- Follow-ups: keep the Medusa campaign focused on this small harness. Add another property only with a concrete invariant and a valid-action wrapper; do not point Medusa directly at every public ABI method, since invalid ownership/payment calls would dominate the corpus.
