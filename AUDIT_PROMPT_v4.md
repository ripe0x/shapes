# External audit brief — Shapes pre-mainnet snapshot

You are an independent smart-contract security auditor. Audit the fixed repository snapshot below
as code that will custody real ETH and redeemable ERC-721 assets on Ethereum mainnet. Report
findings; do not change the audited tree.

## Fixed target

```
repository  https://github.com/ripe0x/shapes
commit      020a85ed079a0a6d554ba34a8fd2d5934006eb3d
short       020a85e
phase       P2 pre-mainnet
```

The snapshot includes the completed D-32 renderer hardening from PR #36. Audit this exact commit,
not a moving branch tip. Record the full commit hash and a clean status in the report.

```bash
git fetch origin
git checkout 020a85ed079a0a6d554ba34a8fd2d5934006eb3d
git status --short
git log -1 --oneline
```

`AUDIT_PROMPT_v2.md` and `AUDIT_PROMPT_v3.md` are historical inputs, not authoritative scope
snapshots. Their attack ideas remain useful, but their pinned commits, test counts, locations,
signatures and architecture descriptions may be stale. Resolve every claim against this commit.

## Scope

The Solidity system and its release guards are in scope:

- `src/Shapes.sol`: payable genesis construction, Shape #0 lifecycle, mint/redeem, recomposition,
  provenance, Black terminal state, reserve accounting, owner/admin separation, renderer and
  collection configuration, direct artist attestation, and ERC-165 capability claims.
- `src/ShapeAuctionHouse.sol` and `src/ShapeCardEscrow.sol`: lot custody, ETH/card bidding,
  anti-sniping, settlement, pull-based lot/proceeds/withdrawal delivery, escrow accounting and
  reentrancy boundaries.
- `src/ShapeLens.sol`: stateless liveness, denomination, state, provenance and preview reads.
- `src/ShapeRenderer.sol` and `src/ShapeCollection.sol`: metadata correctness, geometry/module
  exposure, bounded rendering, replaceability/locking and presentation-only entropy.
- The five externally linked libraries: `ComposeCompute`, `CopyValidation`, `EIP712Signature`,
  `GeometrySampling` and `InkGenes`.
- All interfaces under `src/interfaces/`, especially stable capability ABI and ERC-165 claims.
- `script/DeployShapes.s.sol` and the deployment shell guards: constructor wiring, immutable
  configuration, denomination ladder/profile selection, preflight/postflight assertions and
  credential-safe release behavior.

Tests, specs, prior findings, the canonical TypeScript renderer and generated fixtures are audit
evidence, not trusted implementations. The site and indexer are out of value-custody scope except
where their assumptions can reveal an on-chain safety or liveness failure.

## Security properties to falsify

1. `Shapes` remains solvent: its ETH balance covers all live, non-Black redeemable backing.
2. Minting is the only operation that increases redeemable backing; redemption and sacrifice
   reduce it by exactly the value removed; compose, decompose and split conserve it.
3. No sequence forges origins, exceeds denomination capacity, forges Complete, rerolls ink without
   fresh mint entropy, or escapes the Black terminal state.
4. Every fresh token id is collision-free with every live or decompose-revivable id, including #0.
5. Shape #0 is an ordinary backed, transferable collectible and grants no administrative power.
   Only `admin()` controls mutable presentation/discovery state, within its documented bounds.
6. Direct artist attestation is deployment-bound, one-time, signature-valid and grants no runtime
   authority. The payable genesis constructor cannot misaccount its backing or mint fee.
7. Every linked-library address, immutable dependency, capability id and denomination ladder used
   at deployment matches the intended release; a profile or stale-build mismatch must fail closed.
8. The auction house and card escrow retain no unaccounted ETH or Shapes. Each deposited card and
   lot has one claimant, cannot be claimed twice, and cannot be stranded by another party's
   receiver behavior. Settlement and cancellation cannot be reentered through mint-fee callbacks.
9. A bid is valued from redeemable backing, advances by a representable whole unit, and cannot
   make a bidder pay or lock more than the accepted bid. Anti-sniping can extend but not shorten
   the deadline.
10. Lens and renderer calls cannot mutate value state or become required for redemption. Metadata
    replacement/locking cannot alter token ownership, backing, provenance or redemption rights.
11. Solidity rendering remains byte-identical to the canonical TypeScript fixtures and frozen
    legacy oracle for the accepted grammar. The D-32 helper extraction must not change SVG,
    metadata, tokenURI, ABI, storage, geometry or module semantics.

## Required adversarial review

- Construct concrete call sequences for every suspected value, custody, authorization, replay,
  reentrancy, denial-of-service or accounting issue. Include hostile ERC-721 receivers, contracts
  that are simultaneously seller and fee recipient, forced ETH, unusual admin/owner transfers,
  Shape #0 recomposition, and maximum-card escrow paths.
- Review every external call and every checks-effects-interactions boundary across Shapes, the
  auction house and the escrow. Treat permanent loss or lock of a user's asset as a security
  finding even when global solvency remains intact.
- Resolve D-17 explicitly: `minIncrementBps` is seller-supplied `uint16` without a separate policy
  cap. Determine whether any value causes overflow, an unrepresentable/deadlocked next bid,
  bidder-side loss, or only a disclosed seller-chosen bidding curve. Recommend a bound only if it
  closes a demonstrated property failure.
- Check gas/liveness at protocol extremes, especially the 10,000-unit ladder, 25-module renderer,
  maximum escrow-card count, deep provenance histories and any loop whose bound depends on stored
  or caller-controlled state.
- Compare interfaces, events, NatSpec, deployment scripts and tests to implementation. Treat a
  comment or test assertion as a claim to falsify, not proof.

## Existing evidence, not substitutes for review

- Both default and testnet Foundry profiles pass 453 tests, with four expected RPC-only skips.
- CI also runs the deep contract profile, renderer parity and Medusa reserve lifecycle job.
- Renderer output is byte-identical against unchanged TypeScript fixtures and the frozen Solidity
  oracle; exhaustive valid module-byte and denomination/gene/inversion coverage passes.
- ShapeRenderer runtime is 23,138 bytes default and 23,137 bytes testnet. Shapes runtime is 24,394
  bytes default and 24,373 bytes testnet.
- The full two-bid Sepolia auction #0 lifecycle completed with deadline extension, settlement,
  winner delivery, seller proceeds, empty escrow/lot index, zero retained house ETH/Shapes and
  indexer agreement. This proves one execution, not absence of other attack paths.
- `SECURITY.md`, `project/DECISIONS.md`, `project/RISKS.md` and
  `project/experiments/EXP-004-renderer-module-refactor.md` contain accepted risks and prior
  evidence. Re-report an accepted item only when its stated assumptions are false at this commit.

## Reproduction commands

```bash
forge build
forge test -vv
FOUNDRY_PROFILE=testnet forge test -vv
FOUNDRY_PROFILE=ci forge test -vv

cd preview
npm ci
npx tsc --noEmit
npm test
```

If an RPC-only test is skipped, state that explicitly. Do not substitute the old Sepolia deployment
for this snapshot: the live deployment is exact commit `376bb7b`, while this audit target includes
later code changes and must receive a fresh release rehearsal after findings are resolved.

## Deliverable

For each finding provide severity, exact file and line at commit `020a85e`, violated property, a
concrete sequence with values, impact, smallest safe remediation and a regression test. Separate
confirmed findings from open questions and hardening suggestions. Include a scope/methodology
section, commands actually run, skipped coverage, and a final disposition for D-17.

An empty confirmed-findings section is acceptable. Speculation presented as a finding is not.
