---
name: ideas-governance
description: Govern the deferred ideas ledger at `.ai/project/ideas/ideas.yaml`. Use when the user asks to persist a new "not-now-but-later" idea, edit idea fields, change status, or mark ideas implemented/invalidated/stale. This skill is the only writer for the ideas ledger.
---

# Ideas Governance

## Purpose

Define a stable write contract for deferred ideas so LLMs can capture and maintain ideas consistently over time.

## Inputs

- User request that explicitly asks to record, update, or close idea data
- Existing ledger at `.ai/project/ideas/ideas.yaml`
- Optional context: related task IDs (`T-xxx`) and tags

## Outputs

- Updated `.ai/project/ideas/ideas.yaml`
- Concise change log of created or modified idea records

## Data Contract (MUST)

`ideas.yaml` MUST use this top-level structure:

```yaml
version: 1
updated_at: "YYYY-MM-DD"
summary:
  total: 0
  by_status:
    proposed: 0
    deferred: 0
    promoted: 0
    implemented: 0
    invalidated: 0
    stale: 0
ideas: []
```

Each item in `ideas` MUST include these required fields:

- `id` (`I-xxx`, unique, immutable)
- `title`
- `status` (`proposed|deferred|promoted|implemented|invalidated|stale`)
- `summary` (1-3 sentences)
- `created_at` (`YYYY-MM-DD`)
- `updated_at` (`YYYY-MM-DD`)

Each item MAY include these optional fields, and they MAY be empty (`null`, empty string, or empty list):

- `why_now_not`
- `trigger_to_start`
- `review_after` (`YYYY-MM-DD` when present)
- `tags` (string array)
- `linked_tasks` (`T-xxx` array)
- `linked_function`
- `expected_effect`

All fields except `id`, `title`, `status`, `summary`, `created_at`, and `updated_at` MAY be empty.

## Write Rules (MUST)

1. Treat `.ai/project/ideas/ideas.yaml` as the single source of truth.
2. Never hard-delete an idea. Use status `invalidated` when needed.
3. Allocate the next available `I-xxx` ID for creates.
4. Recompute `summary.total` and `summary.by_status` after every write.
5. Update `updated_at` at file level and idea level on every change.
6. Keep field names and enum values stable unless the user explicitly requests schema changes.

## Status Guidance

- `proposed`: captured and not yet formally deferred
- `deferred`: intentionally postponed for later consideration
- `promoted`: selected to enter delivery planning
- `implemented`: delivered
- `invalidated`: no longer useful or applicable
- `stale`: requires revalidation

## Steps

1. Confirm the user intent is a write operation.
2. Collect only missing required core fields before writing.
3. Apply the minimum change required by the request.
4. Recompute summary counts and timestamps.
5. Return changed IDs and final statuses.

## Boundaries

- Do NOT perform read-only reporting workflows. Use `ideas-lifecycle`.
- Do NOT infer implementation state from source code automatically.
- Do NOT split data into additional files unless the user explicitly requests it.

## Verification

- YAML parses successfully.
- Idea IDs are unique.
- Required core fields exist for every idea.
- `summary.by_status` matches actual counts.
