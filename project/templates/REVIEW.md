# Review record

Independent reviewer output for a diff, branch, or finding. Reviewer must not be the implementer.

- Target: commit range / branch / file set
- Reviewer: agent or human, and mandate (correctness, security, parity, over-engineering)
- Findings: one line each, `path:line severity: problem. fix.` Severity: blocker / should-fix / nit.
- Verified claims: what the reviewer actually executed or re-derived (commands + results), vs what was taken on trust
- Verdict: accept / accept-with-fixes / reject
- Director disposition: per finding — fixed / rejected with reason / deferred to decision id
