# Workflow Data Bank

The structured catalog of every real automation primitive (clicks, locators,
scrapers, inputs, fills) the codebase performs — the source for the Workflow
Graph Editor's n8n-style node palette and for each workflow's pre-placed graph.

**Generated — do not hand-edit.** Produced by per-workflow mining agents and
assembled by the dashboard's data-bank build. Schema: `src/domain/workflow-design/data-bank.ts`.

## Layout

```
config/workflow-design/data-bank/
  raw/<workflow>.json     # per-workflow mining output (one miner each):
                          #   { "workflow": WorkflowDataBank, "systemOps": DataBankOperation[] }
  systems/<system>.json   # SystemCatalog — assembled, deduped palette per system
  workflows/<workflow>.json  # WorkflowDataBank — one workflow's real ordered automation
  index.json              # DataBank — the aggregated bank the palette loads
```

`raw/` is the miners' contribution; `systems/`, `workflows/`, and `index.json`
are assembled from it by the build (merge + dedupe via `mergeSystemOperations`).

## Operation kinds

`navigate · click · fill · select · upload · scrape · wait · assert · control`

Each operation records what it **locates** (`selectorFqn` / `role` /
`accessibleName`), its **data flow** (`inputVar` filled from, `outputVar` scraped
into, `url`, `literalValue`), and **provenance** (`sourceRef`, `verified`,
`tags`, `note`). See the JSDoc in `src/domain/workflow-design/data-bank.ts`.
