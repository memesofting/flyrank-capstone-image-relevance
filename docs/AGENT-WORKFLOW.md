# AI Agent Workflow

This file defines how an AI coding agent should work on the capstone.

## Before coding

Read:

```text
AGENTS.md
docs/PROJECT-REQUIREMENTS.md
docs/PROJECT-ARCHITECTURE.md
```

Then read the current phase:

```text
phases/PHASE-1-DESIGN.md
phases/PHASE-2-VISION-PIPELINE.md
phases/PHASE-3-MATCHING-AND-GUARD.md
phases/PHASE-4-PRODUCTION-EVAL.md
```

## Before database changes

Read:

```text
docs/DATABASE.md
```

Check whether the change needs:

- migration,
- index,
- constraint,
- repository update,
- seed update,
- test.

Never modify the database schema without a migration.

## Before API changes

Read:

```text
docs/API.md
```

Keep:

```text
route -> controller -> service -> repository
```

## Before AI changes

Read:

```text
docs/AI-PIPELINE.md
```

Verify:

- schema validation,
- provider abstraction,
- cost tracking,
- retry behavior,
- model versioning.

## Implementation loop

For each task:

1. Identify the smallest change.
2. Implement it.
3. Run formatting/linting if configured.
4. Run relevant unit tests.
5. Run integration tests when applicable.
6. Update documentation.
7. Update `EVIDENCE.md` only with real evidence.
8. Update `BUILDLOG.md` with AI assistance.
9. Summarize changed files and verification.

## Do not

- invent completed tests,
- invent evaluation scores,
- claim a threshold is validated before evaluation,
- bypass Zod validation,
- put AI calls in request handlers for batch work,
- silently accept invalid model output,
- commit secrets,
- add a frontend,
- add unrelated infrastructure,
- replace project requirements with a generic architecture.

## If requirements conflict

Use this priority:

1. `docs/PROJECT-REQUIREMENTS.md`
2. current phase requirements
3. architecture/database/API documents
4. existing implementation
5. general engineering preferences

If a genuine ambiguity remains, record it in an ADR rather than silently choosing a behavior.

## Completion format

At the end of a task report:

```text
Implemented:
- ...

Verified:
- ...

Not completed:
- ...

Evidence:
- ...
```
