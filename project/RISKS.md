# Risk register

Severity: critical / high / medium / low. Status: open / mitigated / accepted / closed.

- R1 (critical, open) Scaled-ladder mainnet deploy. Main's Denominations.sol is 1/100 scale; a mainnet deploy from it ships wrong immutable economics. Mitigation: deploy-script chain-1 guard (P0), ladder restoration + parity re-pin at P2. Trigger to watch: any deploy-script invocation targeting chain 1.
- R2 (high, open) Loss of uncommitted Surface port. Entire alternative architecture exists only as untracked files in one worktree. Mitigation: preservation commit in P0. Until then: nobody runs git clean in that worktree.
- R3 (closed 2026-08-25) Audit findings were historical: audit base 4e6b3d8 predates main's fix wave (a0ff0af..d2f2e59); current main verified fixed. Residue: M-1 into D-08, PoC-to-regression port task. See D-02.
- R14 (closed 2026-08-25) Raised same day on a misread of the stale audit checkout as current main; current settlement is pull-based claimLot, retryable, no lock. Kept as a register entry so the reasoning is not lost.
- R4 (high, open) Irreversible misconfiguration at mainnet deploy. feeBps/feeRecipient immutable; permanently-reverting feeRecipient bricks minting; wrong owner unrecoverable after renounce. Mitigation: D-05 key plan, deploy rehearsal, per-broadcast decoded confirmation.
- R5 (medium, open) ShapeLens/library divergence. No on-chain binding between lens and Shapes linked-library addresses; a mismatched lens silently serves wrong previews. Mitigation: DeployLens.s.sol behavioral probe is mandatory in every deploy path; consider a CI check that recorded addresses match build artifacts.
- R6 (medium, open) Site RPC single point of failure. Free publicnode endpoint serves all reads and the OG route; no fallback, no SLA. Mitigation: D-12 fallback transport in P1.
- R7 (medium, open) Renderer parity drift via WIP. Uncommitted edits to the canonical TS renderer and its Solidity port on a stale base. Mitigation: D-03 reconciliation in P0; parity CI catches merged drift but not unmerged loss.
- R8 (medium, open) Vendored OpenZeppelin. Upstream security patches do not auto-propagate. Mitigation: version pin recorded; diff against upstream during P2 audit prep.
- R9 (medium, open) Gas infeasibility of deep provenance paths on mainnet. Local demos needed multi-billion gas limits. Mitigation: D-08 ceilings experiment in P1; stop condition on ROADMAP P1.
- R10 (low, open) Auction house stray-NFT deposits unrecoverable. Documented and accepted in SECURITY.md; no admin recovery by design. Status: accepted once user reconfirms at P2.
- R11 (low, open) minIncrementBps unbounded uint16. Seller-side only; needs one reviewer pass (D-17).
- R12 (low, open) Repo hygiene debt. 45 branches, 13 worktrees, _to_delete/ with stale git lock files and tarballs. Mitigation: P0 hygiene pass; cache/dir deletions only with user approval.
- R15 (high, open) CI dead since 2026-08-08 — GitHub Actions billing failure ("recent account payments have failed or your spending limit needs to be increased"). Every main push since, including the audit fix wave and the sepolia-scaled merge, ran zero CI; parity/fixtures/size gates enforced only by local discipline. Mitigation: user fixes billing (GitHub Settings, Billing and plans); then land W-4 (claude/docs-truth-and-size-gate: concurrency-cancel, path filters, forge caching) to cut Actions spend so it does not recur; re-run CI on main tip before declaring the P0 gate.
- R13 (medium, open) ERC-8060 draft drift. Implemented against a moving draft; finalization may diverge from the frozen snapshot. Mitigation: re-check draft status at P2; immutable contract means divergence is a documentation/integration issue, not a code fix.
