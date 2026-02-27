# Semantic Focus Report

Use when the user asks for feature-level semantic summary, decision context, or cross-feature focus.

## Data Source

```bash
node .ai/scripts/ctl-project-governance.mjs query --project <project> --json
cat .ai/project/<project>/feature-map.md
cat .ai/project/<project>/dashboard.md
```

## Output Template

```markdown
## Semantic Focus

**Primary Feature**
- Feature: F-xxx <title>
- Intent:
- Current decision:
- Success signal:

**Cross-feature Signals**
- Dependency:
- Highest risk:
- Next governance checkpoint:

**Evidence**
- feature-map: <Semantic Feature Briefs reference>
- dashboard: <Focus index reference, optional>

**Recommended Next Step**: <one concrete action>
Command: `<executable command>`
```

## Rules
- Only report semantics explicitly documented in `feature-map.md` `Semantic Feature Briefs`.
- Treat `dashboard.md` as index context only; do not use it as semantic body source.
- If semantic fields are missing, report `unknown` and suggest where to update.
- Keep status facts and semantic statements separate.
