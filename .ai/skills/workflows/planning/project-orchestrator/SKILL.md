---
name: project-orchestrator
description: Project-level orchestrator for intake and continuity. Turns a new/ongoing request into a governance decision (reuse vs new task, mapping to Milestone/Feature/Requirement), keeps the project hub consistent (registry/changelog/derived views), and ensures LLM-authored semantic extraction is captured in structured non-AUTO sections. Focuses on planning and coordination, not product code changes.
---

# Project Orchestrator

## Purpose
Provide a **single front door** for project-level governance:
- Prevent duplicate work
- Keep semantic mapping clean (Feature/Requirement <-> Task)
- Advance the project mainline (milestones, priorities)
- Keep the project hub consistent with ongoing work
- Ensure feature-level semantic summaries stay current in structured docs

Project Orchestrator is **project-management oriented**. The workflow should not implement product code changes.

## When to use
Use Project Orchestrator when the request involves any of the following:
- Starting a new development request (feature, bug fix, refactor, integration)
- Continuing work but needing to locate the right task or decide whether to create a new task
- Mapping work to Milestones/Features/Requirements
- Updating project status, milestones, priorities, scope, or archival decisions
- Writing project-level updates (`registry.yaml`, `changelog.md`) to maintain long-term continuity
- Performing or refreshing semantic extraction for feature-level summaries (`feature-map.md`) and focus indexing (`dashboard.md`)

## When to avoid
Avoid using Project Orchestrator for purely local implementation within an already-scoped task when no scope/status/mapping changes are needed. In those cases, proceed with task-level execution workflows and run hub lint/sync later as needed.

## Inputs
- Natural-language request (new work or continuation)
- Optional: constraints (scope, deadlines, dependencies)
- Optional: pointers to existing task docs (`dev-docs/**/active/<task>/...`)

## Process (high-level)
1. Ensure the project hub exists.
   - If missing, instruct to run:
     - `node .ai/scripts/ctl-project-governance.mjs init --project <project>` (default: `main`)
2. Load the current project state:
   - Prefer reading `.ai/project/<project>/registry.yaml`
   - Run lint for sanity if needed:
     - `node .ai/scripts/ctl-project-governance.mjs lint --check --project <project>`
3. Search for related work:
   - Prefer using `ctl-project-governance query` first (LLM-friendly output):
     - `node .ai/scripts/ctl-project-governance.mjs query --project <project> --text "<keywords>"`
     - `node .ai/scripts/ctl-project-governance.mjs query --project <project> --status in-progress`
   - If hub is missing, `query` falls back to scanning `dev-docs/**`
   - Cross-check existing task bundles under `dev-docs/**` when needed
4. Extract semantic signals from current task docs (at minimum `00-overview.md`, `01-plan.md`, and `03-implementation-notes.md` when present):
   - Intent, scope-in/scope-out, decisions, dependencies, risks, success signal, next checkpoint
5. Decide: reuse an existing Task vs propose a new Task.
6. If a new Task is needed:
   - Propose a stable task slug (kebab-case)
   - Do **not** create the task bundle in Project Orchestrator
   - Instruct to create a task bundle via task-level workflows (module-first), then register it:
     - Module scope: `modules/<module_id>/dev-docs/active/<slug>/`
     - Integration scope: `modules/integration/dev-docs/active/<slug>/`
     - Then run: `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project>`
7. Update project hub semantics (when needed):
   - Update `registry.yaml` to map Milestone/Feature/Requirement <-> Task (complete mapping, avoid long-lived `F-000`)
   - Update semantic sections:
     - `.ai/project/<project>/feature-map.md` non-AUTO `Semantic Feature Briefs` (full semantic extraction)
     - `.ai/project/<project>/dashboard.md` `Focus` (concise index only; no full semantic body)
   - Changelog: prefer `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project> --changelog` for registration/status events; add manual entries only for non-status events
8. Regenerate derived views (recommended after mapping changes):
   - `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project>`

## Outputs

Output MUST include a triage decision and actionable command sequence.

### Output Fields

| Field | Description | Example |
|-------|-------------|---------|
| Decision | `REUSE_TASK` / `NEW_TASK` / `PROJECT_UPDATE` | `NEW_TASK` |
| Rationale | One sentence explanation | "No existing task covers OAuth2 integration" |
| Task ID | `T-xxx` or `pending assignment` | `T-005` |
| Slug | kebab-case task slug | `oauth2-provider-integration` |
| Mapping | `M-xxx > F-xxx > R-xxx > T-xxx` | `M-001 > F-002 > R-003 > T-005` |
| Semantic Summary | Structured brief fields for the feature | `Intent / Scope / Risks / Next checkpoint` |
| Next Actions | Numbered command/skill list | See below |

### Next Actions by Decision Type

| Decision | Next Actions |
|----------|--------------|
| NEW_TASK | 1. Create a dev-docs task bundle under module/integration `dev-docs/active/<slug>/` 2. Update `feature-map.md` semantic briefs (full) and `dashboard.md` focus (index) 3. `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project>` 4. `node .ai/scripts/ctl-project-governance.mjs lint --check --project <project>` |
| REUSE_TASK | 1. Read `dev-docs/**/active/<slug>/00-overview.md` 2. Refresh `feature-map.md` semantic brief if feature posture changed 3. (if needed) Update `State:` + `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project>` |
| PROJECT_UPDATE | 1. Edit `.ai/project/<project>/registry.yaml` (or use `map`) 2. Update `feature-map.md` semantic briefs and `dashboard.md` focus index 3. `node .ai/scripts/ctl-project-governance.mjs sync --apply --project <project>` |

## Verification
- If you updated project hub files:
  - `node .ai/scripts/ctl-project-governance.mjs lint --check --project <project>`
- If you changed semantic intent/scope:
  - Confirm `feature-map.md` semantic brief is updated in the same change.
  - Confirm `dashboard.md` stays concise (focus index, no semantic body duplication).
- If you changed SSOT skills:
  - `node .ai/scripts/lint-skills.mjs --strict`
  - `node .ai/scripts/sync-skills.mjs --scope current --providers both --mode reset --yes`

## Boundaries
- Do not implement product code changes in the workflow.
- Do not create task bundles under `dev-docs/**` (delegate to task-level workflows).
- Do not edit generated stubs under `.codex/` or `.claude/` directly.
- Do not treat AUTO-generated derived sections as semantic narrative; semantic summaries belong in `feature-map.md` non-AUTO section.

## Contract
All behavior MUST follow `.ai/project/CONTRACT.md`.
