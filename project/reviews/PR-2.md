# PR #2 review

- Target: PR #2 merged to main as `7fca2b2` after review head `8b2b133` passed required checks.
- Reviewers: Director review of architecture, authorization, standards semantics, deployment, and integration order; independent read-only reviews of ABI/deploy compatibility, Shape #0 lifecycle/tests, and project-plan impact.

## Findings

- CLOSED P1: ERC-173 ambiguity. The collectible read is now `IContractTitle.titleHolder()`; no `owner()` selector is exposed. Shape #0 can move, enter escrow, burn, and revive without being mistaken for administrative control.
- CLOSED P1: capability discovery. Legacy `IShapes` remains `0xbdcee955`; `IAdminControl` is `0x067e35a5`; `IContractTitle` is `0xe1ca0602`. `supportsInterface` and regression tests pin all three, and reject ERC-173 plus the bare `owner()` selector.
- CLOSED P1: the recipient-independent seed test captures the returned mint ids and compares those seeds.
- CLOSED P2: a valid Shape #0 split now checks title extinction, child ids/owners/backing, supply, reserve conservation, and solvency.
- CLOSED P2: direct Shape #0 transfer, safe transfer to a receiver, and self-custody rejection are covered.
- CLOSED P2: collector-domain residue is removed from executable source, the x-ray, and the repository map.
- ACCEPTED CONSTRAINT: direct deployment assigns Shape #0 and admin to the deployer. A future factory must explicitly hand both roles off; no factory exists in the adopted architecture.
- CLOSED integration defect found during final verification: genesis construction no longer underflows when Forge simulates at block 0, with a regression test.
- CLOSED integration defect found during final verification: `e2e-anvil.sh` now accounts for genesis Shape #0 when selecting and redeeming public-mint ids.

## Architecture and integration disposition

- The reserve/accounting and ordinary Shape #0 lifecycle wiring reviewed as coherent. Constructor backing, transfer, auction escrow, redemption, compose-as-input, decomposition revival, admin transfer, and admin renunciation have no confirmed implementation defect.
- This charter-level architecture delta was approved as D-24. It changes constructor value flow, token numbering, authorization, ABI, deployment addresses, and removes the collector capability domain.
- Merge order is satisfied: PR #1 merged as `5eec83d`, then PR #2 was rebased onto it and the combined local gate rerun.
- The existing Sepolia address remains the old immutable architecture. Deploy a fresh implementation, replace deployment metadata/fromBlock, and collect P1 evidence only against the new system.

## Verification

- Solidity: formatting/build pass; 428 tests pass, 0 fail, 4 fork-only skip; testnet-profile title/token/ladder packet passes; Shapes runtime 24,125 bytes with 451-byte EIP-170 margin.
- Deployment: Sepolia-profile dry-run passes without broadcast. Fresh local Anvil broadcast passes deploy, nine-denomination minting, title-inclusive full reserve unwind, transfer, exact redemption, auction settlement, and zero residual house balance.
- Renderer/site: 39 preview tests, TypeScript typecheck, stream verification, 500-per-denomination sweep, fixture freshness, web lint, and production build pass.
- Documentation: selector check and stale collector/current-owner terminology sweep pass.
- Remote contracts and renderer-parity CI passed at review head `8b2b133`. Two independent re-reviews accepted the repaired candidate. The Codex Security diff scan found zero reportable findings.

## Verdict

Accepted and merged as `7fca2b2`. D-24 is explicit, every review finding is closed, canonical docs and Charter are reconciled, and the full local and remote gate is green. A fresh Sepolia deployment/readback is the remaining entry condition for P1.
