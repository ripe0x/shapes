# System

How this project is run. The operating structure, the document map, and the session protocol.

## Operating structure

- One repository. Contracts, canonical TS renderer, site, and indexer are parity-coupled: `web/` imports `preview/src` at build time, CI diffs ladder-specific fixtures against the Solidity port, and the selected Solidity Foundry profile must match the TS `SHAPES_LADDER` build setting. Splitting repos would turn a compile-time coupling into a versioning problem. D-04 fixed standalone Shapes as the architecture; the rejected Surface port is historical only.
- One Director session. The Director owns architecture, strategy, decomposition, integration, decision tracking, risk, and acceptance. The Director does not implement routine work inline; implementation, research sweeps, doc elaboration, and test-writing go to lower-cost worker agents with precise briefs and acceptance commands. Worker briefs open with a role override (hands-on implementer, no sub-delegation), name exact paths, and forbid scope creep.
- Specialist workers, task-scoped, not standing: contract implementer, renderer/parity worker, site worker, indexer worker, docs worker. One worker per repo area at a time; never two workers on the same files.
- Independent review: every non-trivial diff gets a reviewer pass separate from its implementer (in-repo review agent or /code-review). Contract changes additionally get the solidity-auditor pass. Mainnet is gated on an external human audit (D-16); in-repo x-ray and self-audits do not substitute.
- Simulations: preview harness (`simulate.ts`, collision sweep), Foundry fuzz/invariant profiles, fork tests, and the bounded Medusa reserve/lifecycle campaign are the standing simulation layer. Decisions tagged "requires simulation" in DECISIONS.md must cite a run before resolution. D-09 adopted Medusa as an additional stateful property tool and deferred Halmos on measured resource cost; neither is represented as a formal proof.
- Security review: continuous via reviewer passes; formal via the P2 external audit. D-02's historical audit artifacts are preserved and fully triaged; any new contract architecture delta receives an independent review and a pre-implementation decision gate before merge.
- Research workflow: read-only Explore scouts for repo/system questions; web research delegated; findings land as EXPERIMENT records or DECISIONS entries, never as chat-only knowledge.
- Evidence gates: each roadmap phase ends in a gate (ROADMAP.md). No implementation for phase N+1 starts before phase N's gate passes. The merge checklist (templates/MERGE_CHECKLIST.md) is the per-change gate.

## Document map

All canonical docs live in `project/`. Design specs and drafts in `docs/` keep design rationale but their status lines are superseded by STATE.md.

- DIRECTOR.md: the Director role prompt — mandate, division of labor, decision discipline, non-negotiables. A new session assumes the role by reading it.
- CHARTER.md: what the product is, fixed principles, non-goals, success definition. Changes rarely; amendments are logged decisions.
- SYSTEM.md (this file): operating structure, document map, session protocol. Changes when the process changes.
- STATE.md: current phase, deployment reality, component status, at-risk work, known unknowns. The only "current status" authority. Updated before ending every Director session.
- DECISIONS.md: append-only log of decided items plus the grouped backlog of open decisions. Every entry: context, decision or open question, why it matters, what resolves it. Rejected ideas stay listed so they are never silently revived.
- ROADMAP.md: evidence-based phases with objectives, deliverables, acceptance criteria, required evidence, stop conditions.
- RISKS.md: risk register. Id, description, severity, likelihood, mitigation, status.
- templates/TASK_PACKET.md: the worker dispatch brief format.
- templates/EXPERIMENT.md: hypothesis, method, evidence, conclusion format for simulations and research.
- templates/REVIEW.md: reviewer output format.
- templates/MERGE_CHECKLIST.md: per-merge gate.
- ../audits/: every audit brief and report, and the pre-audit x-ray.
- ../docs/: design specs and drafts behind each feature; status lines there are superseded by STATE.md.

## Session protocol (Director)

At the start of every session:
1. Read `project/*.md` (this set).
2. Inspect repo state: `git status`, `git log --oneline -10 main`, worktree list, CI status.
3. Report: current phase, current gate, highest-leverage objective, outstanding decisions, recommended delegated tasks, top risks, single recommended next action.

During the session: strategy and architecture stay in the Director session; routine work is delegated; all important work is personally reviewed before acceptance; implementation never outruns architecture.

Before ending: update STATE.md (and DECISIONS/RISKS if touched), commit doc updates.

## Standing constraints

- Mainnet safety: never broadcast, deploy, or send value without an explicit user instruction for that specific transaction; decoded per-tx confirmation, pre/post-flight reads.
- Commit hygiene: author is ripe0x noreply; verify `git log -1 --format='%an <%ae>'` before any push. Commit verified, coherent work; never a stream of mid-iteration fixes.
- Never clobber WIP not created this session; check mtimes and ownership first.
- Any `Shapes.sol` change runs `forge build --sizes`.
- Ladder or renderer changes run the full parity chain (fixtures regen must be intentional, never incidental).
