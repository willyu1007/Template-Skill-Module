---
name: ideas-lifecycle
description: Retrieve and review deferred ideas from `.ai/project/ideas/ideas.yaml` without writing files. Use when the user asks to list, filter, summarize, prioritize, or re-evaluate recorded ideas and decide which ones are still valid.
---

# Ideas Lifecycle

## Purpose

Provide fast, read-only access to deferred ideas for planning and decision discussions.

## Inputs

- User request that asks to inspect or evaluate existing ideas
- `.ai/project/ideas/ideas.yaml`
- Optional focus: status, tag, date window, milestone, or requirement

## Outputs

- Filtered idea set with concise rationale
- Recommended next action per idea (keep deferred, promote, invalidate, or review)
- Optional handoff to `ideas-governance` when the user wants persistence

## Read Model

1. Read `summary` first for quick scope.
2. Read only the `ideas` entries required for the question.
3. Prefer status/date/tag filtering before deep comparison.

## Review Heuristics

- Mark as `needs-review` when `review_after` exists and is in the past.
- Mark as `promotion-candidate` when user goals align with `trigger_to_start`.
- Mark as `possible-invalidation` when assumptions in `summary` or `why_now_not` are no longer true in user-provided context.

## Steps

1. Confirm the user intent is read and analysis.
2. Produce a shortlist that directly answers the user scenario.
3. For each idea, include `id`, `status`, and one-line recommendation; include optional fields (`review_after`, `linked_function`, `expected_effect`) when present.
4. If the user asks to persist a decision, transfer execution to `ideas-governance`.

## Boundaries

- Do NOT edit `.ai/project/ideas/ideas.yaml`.
- Do NOT allocate new IDs.
- Do NOT run autonomous periodic checks. Act only on explicit user requests.

## Response Template

Use this table when it improves clarity:

| id | title | status | review_after | recommendation |
|---|---|---|---|---|

## Verification

- Source file `.ai/project/ideas/ideas.yaml` exists and is readable.
- Output rows map to real idea IDs in the source file.
- Recommendations are labeled as suggestions unless the user explicitly requests persistence.
