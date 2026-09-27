# Mizan documentation

| Document | Read it when | Kept up to date by |
|---|---|---|
| [MAP.md](MAP.md) | you need to find where something lives | **generated** — `npm run docs:map` (a test fails if stale) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | you want to understand how the parts fit and the accounting rules | every behaviour change |
| [DECISIONS.md](DECISIONS.md) | you wonder *why* it is built this way | every structural choice (one ADR each) |
| [CHANGELOG.md](CHANGELOG.md) | you want the history of what changed | every change, under `[Unreleased]` |
| [LESSONS.md](LESSONS.md) | before starting work — traps already hit | whenever something is learned the hard way |
| [ROADMAP.md](ROADMAP.md) | you want to know what is done and what is next | when plans change |
| [research/ERP-RESEARCH.md](research/ERP-RESEARCH.md) | background: how SAP, Oracle, Odoo, ERPNext … do it | when new research is done |
| [../CLAUDE.md](../CLAUDE.md) | rules for anyone (human or AI) changing the code | when the rules change |

The rule: **code and docs change in the same commit.** The tests enforce the
parts a machine can check (the map, the boundaries, the presence of the docs);
the checklist in `CLAUDE.md` covers the rest.
