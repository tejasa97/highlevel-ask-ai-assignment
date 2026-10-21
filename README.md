# Ask AI — 500-action agent framework

A natural-language assistant over a simulated CRM: 50 modules × 10 actions, with measured latency, cost and quality.

> Work in progress. This README becomes the submission README (architecture, catalog, real vs mocked, evals, trade-offs, limits) as the build lands.

- `docs/ASSIGNMENT.md` (local only, not in the repo): what's being asked, with a requirements checklist
- [docs/PLAN.md](docs/PLAN.md): architecture, design and the 5-day schedule
- [docs/PROMPT-EXAMPLE.md](docs/PROMPT-EXAMPLE.md): the planner prompt over two turns, with real payloads and token counts
- [docs/assignment/](docs/assignment/): the original brief and catalog PDFs

## Layout

```
server/   Node + TypeScript backend (registry, modules, store, agent core)
eval/     scenarios, runner, smoke tests, benchmark report
web/      Vue 3 chat UI
docs/     assignment, plan
```
