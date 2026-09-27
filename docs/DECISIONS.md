# Architecture decisions

Short records of *why* things are built the way they are (ADR style).
Add one for every structural choice; never delete — mark as **Superseded** instead.

---

## ADR-001 · Local server + browser clients on the office LAN
**Status:** Accepted · 2026-09-26
**Context:** Small companies, one office, unreliable internet, no IT staff.
**Decision:** One PC runs a Node server; other PCs use a browser. No cloud dependency.
**Consequences:** Simple install and backup; remote access is out of scope for now.

## ADR-002 · SQLite (WAL) now, PostgreSQL-ready
**Status:** Accepted · 2026-09-27
**Context:** Target is < ~20 people writing at once. See research §7.
**Decision:** One SQLite file in WAL mode with serialised write transactions, behind the `Database`
adapter in `kernel/db.ts`. SQLite-only features (triggers syntax, `node:sqlite`) are kept in migrations.
**Consequences:** Zero administration, one-file backups. If a customer outgrows it, a PostgreSQL adapter
and translated migrations are the path; module code does not change.

## ADR-003 · Integer money
**Status:** Accepted · 2026-09-26
**Decision:** Minor units as integers; quantities ×1000; rates in basis points; BigInt math with
round-half-away-from-zero (`kernel/money.ts`), mirrored in the web preview.
**Consequences:** No float drift; every screen must convert at the edges.

## ADR-004 · Modules ("mechano") with services, events and registries
**Status:** Accepted · 2026-09-26, extended 2026-09-27
**Decision:** Every feature is an `AppModule` owning its tables, permissions, routes and health checks.
Modules talk only through typed services (`contracts/`), synchronous events inside the same
transaction, and registries (`documents.registerKind`, `parties.registerRole`).
A boundary test fails on any cross-module import (server and web).
**Consequences:** Any app can be removed by deleting its folder and its line in the module list;
`scripts/edition.mjs` automates this and proves it with typecheck + tests.

## ADR-005 · Finance split like SAP FI/CO and Odoo
**Status:** Accepted · 2026-09-27
**Context:** "Sales / Purchases" is how small tools slice things; ERPs sell GL, AR, AP, Treasury, Tax, CO.
**Decision:** Apps `gl` (core), `ar`, `ap`, `treasury`, `tax`, `co`, `inventory`, `purchasing`, `pricing`.
Shared engines (`parties`, `catalog`, `documents`) have no app of their own and come with the apps that need them.
**Consequences:** Customers buy exactly the finance pieces they need; a GL-only edition works.

## ADR-006 · Cost centers as a dimension on ledger lines
**Status:** Accepted · 2026-09-27
**Context:** SAP's universal journal (ACDOCA) keeps dimensions on the line, not in side ledgers.
**Decision:** `journal_lines.cost_center_id` (and `document_lines.cost_center_id`); the CO module owns
the `cost_centers` table and validates through the `costCenters` service; reports read the ledger.
Reversals copy the original dimensions without re-validating them.
**Consequences:** One source of truth; CO can be switched off without touching posted data.

## ADR-007 · Roles in the database, rights = union of roles ∩ enabled apps
**Status:** Accepted · 2026-09-27
**Context:** SAP / BC use role collections and permission sets; small firms need something simpler.
**Decision:** Permission keys `module.object.action`. Built-in roles (admin, accountant, viewer) are
rules; custom roles are lists. A user may hold several roles. Effective rights are recomputed on every
request from the roles and the apps that are on. Admin-only rights (users, settings, backups, price
override) never come from rule roles other than admin. Separation-of-duties pairs are declared by
modules and shown as warnings, not blocks.
**Consequences:** Changes apply immediately without re-login; the last active administrator cannot be removed.

## ADR-008 · Reference data readable by any signed-in user
**Status:** Accepted · 2026-09-27
**Decision:** Lists needed to fill a document (tax codes, cost centers, pricing for a party) are `auth`
routes guarded by `assertApp`; writes keep their specific permissions.
**Consequences:** A sales clerk can pick VAT and a cost center without being able to edit them.

## ADR-009 · Documentation is generated where possible and tested
**Status:** Accepted · 2026-09-27
**Decision:** `docs/MAP.md` is generated from the code (`scripts/docs-map.mjs`); a test fails when it is
stale; a Stop hook regenerates it. Changelog, decisions and lessons are updated in the same commit
as the code (rules in `CLAUDE.md`).
**Consequences:** The map never lies; finding where to change something takes one read.

## ADR-010 · Bank reconciliation ticks ledger lines from outside the ledger
**Status:** Accepted · 2026-09-27
**Context:** Posted journal lines are immutable (triggers), and reconciliation belongs to Treasury, not GL.
**Decision:** The `bank` module stores the tick on its own statement line (`journal_line_id`, unique),
never on `journal_lines`. It protects history by locking reconciled statements (triggers) and by
refusing reversals through the `journal.reversed` event (listeners run inside the same transaction).
CSV files are parsed in the browser, so the server receives clean JSON lines and needs no upload handling.
**Consequences:** GL stays untouched and removable-module rules hold; a GL-only edition simply has no
reconciliation. Voided pairs are hidden from the open items instead of needing a manual tick.
