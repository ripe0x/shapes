# PR #2 review

- Target: `origin/main...origin/codex/token-zero-contract-title` at `a64a339`.
- Reviewers: Director review of architecture, authorization, standards semantics, deployment, and integration order; independent read-only reviews of ABI/deploy compatibility, Shape #0 lifecycle/tests, and project-plan impact.

## Findings

- P1: `Shapes.owner()` is repurposed from the widespread administrative-owner meaning to the current holder of Shape #0, including the auction house during escrow and zero while the token is burned. No on-chain authorization reads it, so the holder is powerless inside Shapes, but ERC-173 defines `owner()` as the contract ownership/control identity and motivates registries, exchanges, and UIs that consume it. Selector-only integrations can therefore misattribute control or grant off-chain privileges. Director recommendation: use an explicit `titleHolder()`-style selector. Literal `owner()` requires D-24 user acceptance of the compatibility/security risk. Reference: https://eips.ethereum.org/EIPS/eip-173
- P1: adding `owner()` to `IShapes` changes its advertised ERC-165 id from `0xbdcee955` to `0x306b220e`; the legacy surface is still implemented but no longer detected. The new `IAdminControl` id `0x067e35a5` is also not returned by `supportsInterface`. Preserve the legacy id, advertise the admin capability, and pin all three expectations in tests.
- P1: `test_RecipientDoesNotMoveTheSeed` mints Shape #1 in both branches but compares `seedOf(0)`, the unchanged constructor token. The test passes without testing recipient-independent mint entropy. Capture each returned id and compare those seeds.
- P2: successful Shape #0 split is not tested. The only direct split call uses an empty output array and exercises the generic revert. Add a valid split with conservation, child owner, and `owner()`/title readback assertions.
- P2: Shape #0 safe transfer and self-custody rejection are not tested directly. The implementation is id-agnostic and appears correct; add explicit coverage because #0 now drives a contract-level read.
- P2: `x-ray/x-ray.md` and `x-ray/architecture.svg` retain collector-domain language after the interface, library, scripts, lens reads, mocks, and 39 collector tests are removed.
- P2: the payable exact-value constructor mints Shape #0 and assigns `admin` to `msg.sender`. Repository scripts use direct deployment correctly. Any future factory would receive both roles and must explicitly transfer them; the current no-factory charter makes this a documented integration constraint, not a present defect.

## Architecture and integration disposition

- The reserve/accounting and ordinary Shape #0 lifecycle wiring reviewed as coherent. Constructor backing, transfer, auction escrow, redemption, compose-as-input, decomposition revival, admin transfer, and admin renunciation have no confirmed implementation defect.
- This is a charter-level architecture delta, not P1 cleanup. It changes constructor value flow, token numbering, authorization, ABI, deployment addresses, and removes a capability domain named by Charter principle 5.
- Merge order: merge PR #1 first, rebase PR #2 onto the result, then rerun the combined review. PR #2 is based on current main's build-time ladder commits but lacks PR #1's CI root-lockfile and Netlify/director work.
- If adopted, the existing Sepolia address remains the old immutable architecture. Deploy a fresh implementation, replace deployment metadata/fromBlock, and collect P1 evidence only against the new system.

## Verification

- GitHub contracts job: pass, including build and 425-test claim at the reviewed head.
- GitHub renderer job: failed before install at `actions/setup-node`, because `cache-dependency-path` names deleted `preview/package-lock.json`. This is the known main workflow defect already fixed in PR #1; no renderer/parity assertion ran.
- Director compiled temporary Solidity probes with 0.8.28 to measure interface ids: old `IShapes` `0xbdcee955`; PR #2 `IShapes` `0x306b220e`; `IAdminControl` `0x067e35a5`.
- Collector removal sweep: clean in executable source; only the two stale x-ray references remain.
- Lifecycle review: no confirmed implementation bug; one false-positive security test and three direct coverage gaps.

## Verdict

Request changes. Adopt the Shape #0 + separate-admin direction only after D-24 is explicit; the Director recommends renaming the ceremonial ownership read. Do not merge until every P1 finding is fixed, canonical docs/Charter are reconciled, PR #2 is rebased after PR #1, and the full combined check set is green.
