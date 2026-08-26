# PR #2 review

- Original PR: merged to main as `7fca2b2` after review head `8b2b133` passed required checks.
- Corrective review: commit `ab9db38` on `codex/restore-pr2-owner`, opened as draft PR #3 from main `a1f34fd`, restoring PR #2's intended `owner()` API before any deployment.
- Reviewers: Director review of architecture, authorization, standards semantics, deployment, and integration order; independent read-only reviews of ABI compatibility, Shape #0 lifecycle, terminology, and security.

## Review incident

The original PR exposed `owner()` as the current holder of backed Shape #0 and kept all authority in a separate `admin()` role. The Director raised an ERC-173 compatibility concern, then incorrectly treated a general instruction to proceed as approval to replace that product API with `IContractTitle.titleHolder()`. The user did not approve the substitution. It is being reverted. DIRECTOR.md now forbids changing fundamental behavior, contract semantics, public ABI, or PR architecture on inferred approval.

## Retained PR #2 findings and fixes

- CLOSED: the recipient-independent seed test captures the returned mint ids and compares those seeds.
- CLOSED: a valid Shape #0 split checks child ids, owners, backing, supply, reserve conservation, solvency, and the temporary zero `owner()` state.
- CLOSED: direct Shape #0 transfer, safe transfer to a receiver, and self-custody rejection are covered.
- CLOSED: collector-domain residue is removed from executable source, the x-ray, and the repository map.
- ACCEPTED CONSTRAINT: direct deployment assigns Shape #0 and admin to the deployer. A future factory must explicitly hand both roles off; no factory exists in the adopted architecture.
- CLOSED: genesis construction no longer underflows when Forge simulates at block 0, with a regression test.
- CLOSED: `e2e-anvil.sh` and SeedDemo account for genesis Shape #0 when selecting public-mint ids.

## Restored architecture under review

- `owner()` returns `ownerOf(0)` without reverting, or zero while Shape #0 is burned or split.
- Shape #0 is otherwise an ordinary backed ERC-721 and may move, enter auction escrow, redeem, compose, decompose, and split.
- `owner()` grants no authority. Every configuration authorization check reads the separate transferable and renounceable `admin()` role.
- No `titleHolder()` selector or `IContractTitle` interface remains.
- The existing Sepolia address is the old immutable architecture. Do not deploy or relabel it as this architecture.

## Review conclusions

- ACCEPTED PRODUCT TRADEOFF: exposing `owner()` without ERC-173 `transferOwnership(address)` can confuse selector-only Ownable tooling, but the contract does not advertise ERC-173 and every authorization check reads only `admin()`. Independent behavior review and the security scan found no on-chain authorization defect. This concern did not authorize the Director's rename.
- OPEN P1 COMPATIBILITY DEFECT: adding `owner()` directly to `IShapes` changes `type(IShapes).interfaceId` from legacy `0xbdcee955` to `0x306b220e`; the candidate advertises only the new id. Consumers probing the pre-PR2 capability will reject the new deployment even though it still implements every old function. D-25 requires the user to choose explicit dual-id support (recommended) or intentional prelaunch breakage.

## Verification

- `forge fmt`: pass.
- `forge build --sizes`: pass; Shapes runtime 24,131 bytes, 445-byte EIP-170 margin.
- `forge test`: 428 passed, 0 failed, 4 fork-only skipped.
- Testnet profile: 27 ownership/token/ladder tests passed.
- Preview: 39 tests and TypeScript typecheck passed.
- Independent behavior review: accept, no functional or authorization defect.
- Independent ABI review: confirmed the R18 compatibility break and the non-authorizing ERC-173 tooling risk.
- Codex Security diff scan `704e538c-4db4-4ce3-b255-fd523cc47b35`: complete, zero reportable findings.

## Verdict

Request decision; do not merge yet. The restored `owner()` behavior is coherent and security-clean, but the legacy ERC-165 discovery break is real. Resolve D-25 without substituting another product API, rerun the narrow interface/build/test gate, then merge.
