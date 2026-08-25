# Merge checklist

Per merge to main. All boxes or a written waiver in the merge commit body.

- [ ] Scope matches an approved task packet or decision id; no silent scope growth
- [ ] Full test suite green locally (`forge test`); CI profile expected to pass
- [ ] Contract touched: `forge build --sizes` run, Shapes margin recorded
- [ ] Renderer/ladder touched: parity chain green (fixtures diff intentional and reviewed, sweep, ParityTest)
- [ ] Independent review record exists (templates/REVIEW.md); blockers closed
- [ ] RPC-touching change: new call sites audited (source, frequency, caching) per RPC discipline
- [ ] Docs updated: STATE.md if status changed, DECISIONS.md if a decision closed, legacy docs not newly contradicted
- [ ] No secrets, no binary curl output, no author-identity overrides; author verified `ripe0x <109935398+ripe0x@users.noreply.github.com>`
- [ ] No deploy/broadcast side effects in scripts run
- [ ] Commit message states what and why; iteration squashed to coherent commits
