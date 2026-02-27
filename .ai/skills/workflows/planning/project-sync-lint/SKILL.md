---
name: project-sync-lint
description: Project hub synchronizer and validator. Scans the repo (including multiple dev-docs roots), validates project/task metadata against the Project Contract, repairs drift by generating missing task identity meta (.ai-task.yaml) and regenerating derived views, and enforces complete task-feature mapping plus LLM-authored semantic extraction for feature-level governance.
---

# Project Sync/Lint

## Purpose
Provide **centralized** synchronization and validation for the project governance system:
- Lint: enforce the Project Contract and detect drift
- Sync: generate missing `.ai-task.yaml` (IDs), upsert `registry.yaml`, and regenerate derived views
- Semantic governance: keep feature-level semantic briefs and dashboard focus index aligned with current tasks
- CI: run in check-only mode to block inconsistent changes (errors only; warnings do not fail by default)

This skill is **repo governance oriented**. It should not implement product code changes.

## Commands
All commands are implemented by:
- `node .ai/scripts/ctl-project-governance.mjs`

### Init
Create `.ai/project/<project>/` files from templates (idempotent).

```bash
node .ai/scripts/ctl-project-governance.mjs init --project main
```

### Lint (check-only)
Scan all configured or discovered `dev-docs` roots and validate the repo against the contract.

```bash
node .ai/scripts/ctl-project-governance.mjs lint --check --project main
```

### Sync (dry-run or apply)
Generate missing task identity meta, upsert registry tasks, and regenerate derived views.

```bash
node .ai/scripts/ctl-project-governance.mjs sync --dry-run --project main
node .ai/scripts/ctl-project-governance.mjs sync --apply --project main
```

Optional: append sync-detected events to the hub changelog (append-only; apply-mode only):
```bash
node .ai/scripts/ctl-project-governance.mjs sync --apply --project main --changelog
```

## Semantic Governance Requirements

### 1) Complete task-feature records
- Active tasks MUST have valid `task_id` and status sourced from `00-overview.md`.
- Active tasks SHOULD be mapped to explicit `feature_id` and `milestone_id` in `registry.yaml`.
- Tasks in `in-progress` or `blocked` MUST NOT remain on `F-000` unless intentionally triaged and explicitly noted in `feature-map.md` semantic briefs section.
- Tasks tied to concrete requirements SHOULD include `requirement_ids`.

### 2) Semantic extraction (LLM-authored, structured)
- Semantic extraction MUST be performed from current artifacts, at minimum:
  - `modules/**/dev-docs/active/<task>/00-overview.md`
  - `modules/**/dev-docs/active/<task>/01-plan.md`
  - `modules/**/dev-docs/active/<task>/03-implementation-notes.md` (if present)
  - `.ai/project/<project>/registry.yaml`
- Extracted semantics MUST be recorded in:
  - `.ai/project/<project>/feature-map.md` non-AUTO section (`Semantic Feature Briefs`)
- Dashboard focus MAY be updated as a concise index, but MUST NOT contain full semantic extraction body.
- Feature briefs SHOULD cover: intent, scope in/out, decision, dependencies, risks, success signal, related tasks, and next checkpoint.

### 3) Structure discipline
- Keep AUTO-generated marker blocks intact.
- Treat non-AUTO sections as narrative context; treat AUTO sections as machine-generated facts.

## Contract highlights (read the full contract)
- Task progress SoT: task bundle `00-overview.md` `State:`
- Task identity SoT: `.ai-task.yaml` `task_id`
- Project semantic SoT: `.ai/project/<project>/registry.yaml`
- Migration: missing `.ai-task.yaml` is a warning, but invalid/duplicate IDs are errors

## Recommended flow
1. Run lint:
   - `node .ai/scripts/ctl-project-governance.mjs lint --check --project main`
2. Preview sync updates:
   - `node .ai/scripts/ctl-project-governance.mjs sync --dry-run --project main --init-if-missing`
3. Review task mappings (especially active tasks):
   - `node .ai/scripts/ctl-project-governance.mjs query --status in-progress --project main --json`
   - `node .ai/scripts/ctl-project-governance.mjs query --status blocked --project main --json`
4. Complete semantic extraction and update semantic sections:
   - `.ai/project/main/feature-map.md`
   - (optional) update `.ai/project/main/dashboard.md` focus index only
5. Apply sync when ready:
   - `node .ai/scripts/ctl-project-governance.mjs sync --apply --project main`

## Verification
- Lint (check-only):
  - `node .ai/scripts/ctl-project-governance.mjs lint --check --project main`
- Sync preview (no writes):
  - `node .ai/scripts/ctl-project-governance.mjs sync --dry-run --project main --init-if-missing`
- Manual semantic checks:
  - Every active feature with running work has a `Semantic Feature Brief`.
  - `dashboard.md` `Focus` is concise and references current primary feature/checkpoint.
  - Full semantic narrative exists in `feature-map.md`, not dashboard.
  - In-progress/blocked tasks mapped to `F-000` are either resolved or explicitly justified.
- If you changed SSOT skills:
  - `node .ai/scripts/lint-skills.mjs --strict`
  - `node .ai/scripts/sync-skills.mjs --scope current --providers both --mode reset --yes`

## Boundaries
- Do not edit `.codex/skills/` or `.claude/skills/` directly (generated).
- Do not require Python or third-party dependencies for governance scripts.
- Do not treat `.ai-task.yaml.status` as authoritative for task progress.
