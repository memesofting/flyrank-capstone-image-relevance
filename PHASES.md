# Phase Map

This is the agent-facing index for the capstone.

| Phase | File | Gate |
|---|---|---|
| 1 | `phases/PHASE-1-DESIGN.md` | One-page design document committed |
| 2 | `phases/PHASE-2-VISION-PIPELINE.md` | All images tagged; costs visible |
| 3 | `phases/PHASE-3-MATCHING-AND-GUARD.md` | Fox ranks first; wolf rejected |
| 4 | `phases/PHASE-4-PRODUCTION-EVAL.md` | Eval precision measured; submission pack complete |

## Recommended execution order

```text
AGENTS.md
   ↓
PHASES.md
   ↓
docs/PROJECT-REQUIREMENTS.md
   ↓
Phase 1
   ↓
Phase 2
   ↓
Phase 3
   ↓
Phase 4
```

Do not skip a phase gate.

## Core principle

The system is not considered successful merely because it finds a visually or semantically similar image.

It must also know when **not** to recommend an image.

That is the purpose of the mismatch guard.
