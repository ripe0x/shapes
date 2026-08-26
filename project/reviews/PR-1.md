# PR #1 review

- Target: `main...claude/project-director-setup-886e07`, including the 2026-08-25 corrective docs and ESLint diff.
- Reviewers: independent worker reviews for executable correctness/safety, documentation consistency, and ESLint compatibility; Director review for deployment guard, phase gate, and final disposition.

## Findings

- Closed: STATE/HANDOFF contradicted the passed P0 gate and retained stale pre-hygiene status. Corrected across STATE, HANDOFF, DECISIONS, RISKS, ROADMAP, and the historical x-ray revision label.
- Closed: `web/eslint.config.mjs` imported flat arrays from `eslint-config-next` 15.5.23, which exports legacy config objects. Replaced with ESLint 9 `FlatCompat`; independent re-review found no rule or ignore regression.
- Closed: Netlify built from the repository root but its configuration lived at `web/netlify.toml`, so the platform invoked a nonexistent root `npm run build`. Moved the config to repository root and set `base = "web"`; remote deploy preview passed on `c543df2`.
- No findings: chain-1 ladder guard runs before broadcast in all three deploy entrypoints and rejects the scaled `Denominations.UNIT` on chain 1.
- No findings: renderer CI correctly installs from the root workspace lockfile.
- Closed after the original review: direct-to-main build-time ladder commits made DeployShapes/DeploySepolia conflict with PR #1's interim chain-id guard. The branch now takes main's stronger profile-aware assertions; the inherited interim guard remains only for DeployLens until the ladder work is consolidated further.
- Closed during combined verification: `collisionSweep.ts` subtracted every vocabulary kind except triangle/half from the zero-degree bucket even though the expanded vocabulary has six other rotatable kinds. This yielded negative counts. The sweep now derives rotatable kinds from canonical `ROT_COUNT` and fails on any accounting mismatch.

## Verified claims

- `git diff --check`: pass.
- `bash script/check-docs.sh`: pass.
- `npm run lint --workspace web`: pass.
- `npm run build --workspace web`: pass, with existing optional WalletConnect/MetaMask module warnings.
- `netlify build --offline --context deploy-preview --filter web`: pass; root `netlify.toml` selected, current directory `web`, Next.js function bundling complete.
- `npx tsc --noEmit --project preview/tsconfig.json`: pass.
- `forge test`: 430 passed, 0 failed, 4 fork tests skipped because `MAINNET_RPC_URL` was not supplied.
- `forge build --sizes`: pass; `Shapes` runtime size 24,410 bytes, 166-byte EIP-170 margin.
- Post-main reconciliation: full `forge test` passed 454 tests with 4 fork-only skips; `forge build --sizes` reports Shapes runtime size 24,431 bytes, 145-byte margin. Preview typecheck/verify/sweep/fixture freshness and web lint/build pass.
- GitHub Actions on implementation tip `c543df2`: contracts and renderer parity passed. Netlify deploy preview, header rules, and redirect rules passed; pages-changed correctly skipped.

## Verdict

Accept subject to the post-integration check rerun. Director disposition: all review findings fixed, no waiver requested; current main has been reconciled and must be green as a combined tree before merge.
