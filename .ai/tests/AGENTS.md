# `.ai/tests/` - Feature Smoke Tests

## Purpose

Centralized smoke tests for feature-pack `ctl-*.mjs` scripts. Validates init -> verify workflows.

## Quick Reference

| Suite | Script Under Test | Key Workflow |
|-------|-------------------|--------------|
| `ui` | `ui_gate.py`, `image_style_probe.py` | governance gate, style intake |
| `environment` | `env_contractctl.py`, `env_localctl.py`, `env_cloudctl.py` | contract -> local -> cloud |
| `database` | `db_connect_check.py`, `db_schema_snapshot.py` | connect -> snapshot |
| `context-awareness` | `ctl-context.mjs` | init -> add-artifact -> touch -> verify |
| `deployment` | `ctl-deploy.mjs` | init -> add-service -> plan -> verify |
| `modular-system` | `modular.mjs`, `ctl-module.mjs`, `ctl-flow.mjs` | ID validation, participates_in |
| `api-index` | `ctl-api-index.mjs` | generate -> verify -> diff (multi-module aggregation) |

## Commands

```bash
# List available suites
node .ai/tests/run.mjs --list

# Run specific suite
node .ai/tests/run.mjs --suite ui
node .ai/tests/run.mjs --suite environment
node .ai/tests/run.mjs --suite database
node .ai/tests/run.mjs --suite context-awareness
node .ai/tests/run.mjs --suite deployment
node .ai/tests/run.mjs --suite modular-system
node .ai/tests/run.mjs --suite api-index

# Keep evidence on PASS (debug)
node .ai/tests/run.mjs --suite <name> --keep-artifacts
# or: KEEP_TEST_ARTIFACTS=1 node .ai/tests/run.mjs --suite <name>
```

## Evidence

| Outcome | Evidence Location | Behavior |
|---------|-------------------|----------|
| PASS | `.ai/.tmp/tests/<suite>/<run-id>/` | Auto-deleted |
| FAIL | `.ai/.tmp/tests/<suite>/<run-id>/` | Kept for debugging |

Evidence includes: `run.json`, `runner.log`, per-test `*.stdout.log`, `*.stderr.log`.

## Structure

```
.ai/tests/
|-- run.mjs              # Entry point
|-- lib/
|   |-- evidence.mjs     # Evidence dir + logging
|   |-- exec.mjs         # Command runner
|   |-- python.mjs       # Python interpreter detection
|   `-- text.mjs         # Assertion helpers
`-- suites/
    |-- ui/
    |-- environment/
    |-- database/
    |-- context-awareness/
    |-- deployment/
    `-- api-index/
```

## Adding a New Suite

1. Create `suites/<name>/index.mjs` exporting `run(ctx)`
2. Create test files (e.g., `suites/<name>/<test>-smoke.mjs`)
3. Register in `run.mjs`: import and add to the `SUITES` object

## Dependencies

- Node.js >= 18
- Python 3.9+ (for `ui`, `environment`, `database` suites)
