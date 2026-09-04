# Audits

Every audit brief written for Shapes and every report returned into the repository. Each brief
pins one commit; audit that commit, not a branch tip. Proof-of-concept tests retained from the
audits live in `test/audit/`.

Commit hashes cited by briefs and reports before 2026-08-25 refer to the pre-rewrite history.
`project/HASHMAP.md` translates them.

| Brief | Pinned commit | Scope | Reports |
|---|---|---|---|
| [AUDIT_PROMPT_v2.md](AUDIT_PROMPT_v2.md) | `fea94f9` | recomposition, provenance, Black state, ink genes, composability | outcome in `SECURITY.md` |
| [AUDIT_PROMPT_v3.md](AUDIT_PROMPT_v3.md) | `185bd0f` | auction layer, collection contract, id allocator | |
| [AUDIT_PROMPT_v4.md](AUDIT_PROMPT_v4.md) | `020a85e` | external pre-mainnet snapshot | |
| [AUDIT_PROMPT_v5.md](AUDIT_PROMPT_v5.md) | `dba4dbf` | external pre-mainnet release | |
| [AUDIT_PROMPT_v6.md](AUDIT_PROMPT_v6.md) | `1054db2` | flat-fee candidate, the code deployed to Sepolia | |
| [AUDIT_PROMPT_v7.md](AUDIT_PROMPT_v7.md) | `c583c76` | owner-token candidate | |
| [AUDIT_PROMPT_v8.md](AUDIT_PROMPT_v8.md) | `7f6ccb5` | architecture release: delegatecall libraries, every protocol fact on the token | [claude](AUDIT_REPORT_v8_claude.md), [codex](AUDIT_REPORT_v8_codex.md) |
| [AUDIT_PROMPT_v9.md](AUDIT_PROMPT_v9.md) | `34d2c3b` | v8 deltas plus a tenth adversarial pass | [claude](AUDIT_REPORT_v9_claude.md), [codex](AUDIT_REPORT_v9_codex.md) |

Briefs without a report column entry were run outside the repository; the findings that changed
code are recorded in `SECURITY.md` and `project/DECISIONS.md`. Every v8 and v9 finding was fixed
or accepted with rationale before the mainnet deploy (`project/STATE.md`, decisions D-43 and D-44).

Related reviews in `project/reviews/`: the diff-focused review
`diff-review-7f6ccb5-2bc389a.md`, the fuzz, invariant and Slither campaign
`fuzz-campaign-1c2cfd9.md`, and `architecture-security-2026-09-03.md`.

## x-ray

[x-ray/x-ray.md](x-ray/x-ray.md) is the pre-audit report: protocol overview, threat model, attack
surfaces, invariants ([x-ray/invariants.md](x-ray/invariants.md)), entry points
([x-ray/entry-points.md](x-ray/entry-points.md)) and an architecture diagram. It is a snapshot of
the pre-architecture-pass tree; `project/ARCHITECTURE.md` is current.
