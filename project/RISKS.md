# Risk register

Severity: critical / high / medium / low. Status: open / mitigated / accepted / closed.

- R1 (critical, open) Scaled-ladder mainnet deploy. Main's Denominations.sol is 1/100 scale; a mainnet deploy from it ships wrong immutable economics. Mitigation: deploy-script chain-1 guard (P0), ladder restoration + parity re-pin at P2. Trigger to watch: any deploy-script invocation targeting chain 1.
- R2 (high, open) Loss of uncommitted Surface port. Entire alternative architecture exists only as untracked files in one worktree. Mitigation: preservation commit in P0. Until then: nobody runs git clean in that worktree.
- R3 (high, TRIAGED->active) Security findings landed (branch claude/shapes-security-audit-fa49c8 @ 6480f1c, 23 PoCs pass). See DECISIONS D-02. Live items: H-1 (bid-lock, CONFIRMED, must-fix, P0 stop condition active), H-2 (grind, likely accept after reconcile), M-1/M-2/L-1 open. Mitigation: H-1 fix spec before any other contract work merges.
- R14 (high, open) H-1 escrowed-bid lock. ShapeAuctionHouse settlement couples an untrusted transferFrom with state that permanently excludes the winner from recovery; deployed on Sepolia. Mitigation: settlement redesign isolating the untrusted transfer (D-02/H-1). No mainnet path until closed.
- R4 (high, open) Irreversible misconfiguration at mainnet deploy. feeBps/feeRecipient immutable; permanently-reverting feeRecipient bricks minting; wrong owner unrecoverable after renounce. Mitigation: D-05 key plan, deploy rehearsal, per-broadcast decoded confirmation.
- R5 (medium, open) ShapeLens/library divergence. No on-chain binding between lens and Shapes linked-library addresses; a mismatched lens silently serves wrong previews. Mitigation: DeployLens.s.sol behavioral probe is mandatory in every deploy path; consider a CI check that recorded addresses match build artifacts.
- R6 (medium, open) Site RPC single point of failure. Free publicnode endpoint serves all reads and the OG route; no fallback, no SLA. Mitigation: D-12 fallback transport in P1.
- R7 (medium, open) Renderer parity drift via WIP. Uncommitted edits to the canonical TS renderer and its Solidity port on a stale base. Mitigation: D-03 reconciliation in P0; parity CI catches merged drift but not unmerged loss.
- R8 (medium, open) Vendored OpenZeppelin. Upstream security patches do not auto-propagate. Mitigation: version pin recorded; diff against upstream during P2 audit prep.
- R9 (medium, open) Gas infeasibility of deep provenance paths on mainnet. Local demos needed multi-billion gas limits. Mitigation: D-08 ceilings experiment in P1; stop condition on ROADMAP P1.
- R10 (low, open) Auction house stray-NFT deposits unrecoverable. Documented and accepted in SECURITY.md; no admin recovery by design. Status: accepted once user reconfirms at P2.
- R11 (low, open) minIncrementBps unbounded uint16. Seller-side only; needs one reviewer pass (D-17).
- R12 (low, open) Repo hygiene debt. 45 branches, 13 worktrees, _to_delete/ with stale git lock files and tarballs. Mitigation: P0 hygiene pass; cache/dir deletions only with user approval.
- R13 (medium, open) ERC-8060 draft drift. Implemented against a moving draft; finalization may diverge from the frozen snapshot. Mitigation: re-check draft status at P2; immutable contract means divergence is a documentation/integration issue, not a code fix.
