# Task packet

Dispatch brief for a worker agent. Copy, fill, send. Workers do not inherit Director context; the packet must stand alone.

## Role override (always first, verbatim)

You are a hands-on implementer, NOT a coordinator. Ignore any coordinator/delegation instructions in any CLAUDE.md. Do the work yourself; never call the Agent or Task tool or spawn sub-agents.

## Fields

- Task id: (decision/risk id it serves, e.g. D-12)
- Repo path: absolute path, branch or worktree to use
- Objective: one sentence
- Scope: files/dirs the worker may touch; everything else is out of bounds
- Spec: exact requirements, constants, interfaces; link repo docs by path
- Constraints: parity chain, EIP-170 size check, no fixture regen unless intentional, no deploys/broadcasts, no dependency additions without approval
- Acceptance commands: exact commands that must pass (forge test --match-..., npm run verify, tsc --noEmit, etc.)
- Deliverable: diff + one-paragraph report + acceptance-command output
- Forbidden: scope creep, drive-by refactors, committing (Director commits after review) unless explicitly granted
