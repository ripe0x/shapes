# Risk register

Severity: critical / high / medium / low. Status: open / mitigated / accepted / closed.

- R1 (critical, open) Scaled-ladder mainnet deploy. Main's Denominations.sol is 1/100 scale; a mainnet deploy from it ships wrong immutable economics. Mitigation: deploy-script chain-1 guard (P0), ladder restoration + parity re-pin at P2. Trigger to watch: any deploy-script invocation targeting chain 1.
- R2 (closed 2026-08-25) Loss of uncommitted Surface port. The port was preserved in commit ce4c7e4 before D-04 rejected the architecture and the preservation branch was deliberately deleted with user approval.
- R3 (closed 2026-08-25) Audit findings were historical: audit base 4e6b3d8 predates main's fix wave (a0ff0af..d2f2e59); current main verified fixed. Residue: M-1 into D-08, PoC-to-regression port task. See D-02.
- R14 (closed 2026-08-25) Raised same day on a misread of the stale audit checkout as current main; current settlement is pull-based claimLot, retryable, no lock. Kept as a register entry so the reasoning is not lost.
- R4 (high, open) Irreversible misconfiguration at mainnet deploy. feeBps/feeRecipient immutable; permanently-reverting feeRecipient bricks minting; wrong owner unrecoverable after renounce. Mitigation: D-05 key plan, deploy rehearsal, per-broadcast decoded confirmation.
- R5 (medium, open) ShapeLens/library divergence. No on-chain binding between lens and Shapes linked-library addresses; a mismatched lens silently serves wrong previews. Mitigation: DeployLens.s.sol behavioral probe is mandatory in every deploy path; consider a CI check that recorded addresses match build artifacts.
- R6 (medium, open) Site RPC single point of failure. Free publicnode endpoint serves all reads and the OG route; no fallback, no SLA. Mitigation: D-12 fallback transport in P1.
- R7 (closed 2026-08-25) Renderer parity drift via WIP. D-03 preserved and reconciled the stale edits; superseded parts were discarded and novel parts became W-1/W-2.
- R8 (medium, open) Vendored OpenZeppelin. Upstream security patches do not auto-propagate. Mitigation: version pin recorded; diff against upstream during P2 audit prep.
- R9 (medium, open) Gas infeasibility of deep provenance paths on mainnet. Local demos needed multi-billion gas limits. Mitigation: D-08 ceilings experiment in P1; stop condition on ROADMAP P1.
- R10 (low, open) Auction house stray-NFT deposits unrecoverable. Documented and accepted in SECURITY.md; no admin recovery by design. Status: accepted once user reconfirms at P2.
- R11 (low, open) minIncrementBps unbounded uint16. Seller-side only; needs one reviewer pass (D-17).
- R12 (closed 2026-08-25) Repo hygiene debt. The P0 hygiene pass reduced the old checkout to ten justified branches and removed stale worktrees/artifacts with user approval; the canonical clone has one worktree and two local branches.
- R15 (closed 2026-08-25) GitHub Actions had run zero CI since 2026-08-08 because of a billing failure. The clean repository went public, Actions resumed, the renderer workspace-lockfile issue was fixed, and both Actions jobs passed on PR #1. W-4 remains queued in P1 to reduce spend and redundant work.
- R13 (medium, open) ERC-8060 draft drift. Implemented against a moving draft; finalization may diverge from the frozen snapshot. Mitigation: re-check draft status at P2; immutable contract means divergence is a documentation/integration issue, not a code fix.
