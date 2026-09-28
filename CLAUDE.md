# Working on Mizan — rules for every change

Mizan is a local-network, bilingual (EN/AR) double-entry accounting system for
small and lower-mid companies. **Simplicity and ease of use come first.**

## Before you start

0. **If `docs/HANDOFF.md` exists, read it and finish it first** — it is unfinished work (and the user's
   standing preferences) left by the previous session.
1. Read `docs/MAP.md` — it says which module and file own what. Do not search the whole tree first.
2. Read the last entries of `docs/CHANGELOG.md` and `docs/LESSONS.md`.
3. Check `docs/DECISIONS.md` before changing anything structural.

## The mechano rules (enforced by `apps/server/src/test/boundaries.test.ts`)

- Server: a module imports only `kernel/`, `contracts/`, the core modules (`system`, `ledger`) and its own folder.
  Talk to other modules through a **service** (typed in `contracts/`), an **event**, or a **registry**
  (`documents.registerKind`, `parties.registerRole`). Never write another module's tables.
- Web: `modules/X` imports only `core/`, `ui/`, `engines/`, `lib/`, `styles/` and itself.
- A new module folder must be added to `scripts/edition.mjs` (the test checks it).
- Money is integer minor units; quantities ×1000; rates in basis points. Post to the books only through the ledger service.
- Permissions are `module.object.action` (actions: read, write, post, approve, manage, override).
  Every new permission needs `perms.objects.*` text in both dictionaries.
- Every user-visible text goes in **both** `apps/web/src/core/locales/en.ts` and `ar.ts` (tsc checks the shape).

## Definition of done — every change, without being asked

1. `npm run typecheck` and `npm test` pass (the tests include the boundary, edition and docs checks).
2. **Docs updated in the same commit:**
   - `npm run docs:map` → regenerates `docs/MAP.md` (a test fails if it is stale; a Stop hook also runs it).
   - `docs/CHANGELOG.md` → add a line under `[Unreleased]` (Added / Changed / Fixed).
   - `docs/LESSONS.md` → add anything learned the hard way (a bug's real cause, a trap, a tool quirk).
   - `docs/DECISIONS.md` → add an ADR for any structural choice (new module, new dependency, data model change).
   - `docs/ARCHITECTURE.md` / `docs/ROADMAP.md` → when behaviour or plans change.
3. For a new app: `node scripts/edition.mjs <apps> --check` builds and tests an edition without the others.
4. Review your own diff for bugs and logic errors before committing.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | server + web with reload |
| `npm test` | all server tests (accounting, inventory, modules, boundaries, docs) |
| `npm run typecheck` | both apps |
| `npm run docs:map` | regenerate the program map |
| `npm run edition -- finance --check` | build + test an edition (`--list` for apps and presets) |
