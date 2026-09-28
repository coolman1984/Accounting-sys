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

## ADR-011 · Multi-currency: document currency + base figures, IAS 21 simplified
**Status:** Accepted · 2026-09-27
**Decision:** Each invoice/bill/payment keeps its currency, its rate (× 1,000,000) and its foreign
figures; base figures are computed once per line and are what journals, stock, tax, ageing and reports
read, so every journal balances by construction. Settlements store both amounts; the last settlement
of a document takes the exact base remainder. Realised differences are booked by the payment;
unrealised ones by a revaluation run into separate adjustment accounts (receivables / payables),
reversed the next day, so ageing stays at historical values. Foreign cash is revalued in the account.
**Consequences:** Rounding never leaves stray cents; currencies with 0 or 3 decimals are held at the
company's precision (documented limitation).

## ADR-012 · Financial analysis is a separate paid app; statements stay in the core
**Status:** Accepted · 2026-09-27
**Context:** Research in `docs/research/FINANCIAL-ANALYSIS.md` (Part 4).
**Decision:** Every statement (including changes in equity and common-size views) is core GL. The
ratio engine, notes, break-even and trend live in the `analysis` module/app, which only reads the
ledger (through `ledger/statements.ts`) and posts nothing. The engine is pure functions (`engine.ts`),
tested against a hand-worked company; every ratio returns a value or a reason, never ∞/NaN.
**Consequences:** Statements are never held back from a customer; analysis can be sold, trialled and
improved on its own, and removed from an edition with no side effects.

## ADR-013 · Budgets: money-based flexible budget, JSON month arrays, approval lock
**Status:** Accepted · 2026-09-27
**Context:** Small companies budget money per account, not standard units per product; the variance
analysis must still separate "we sold less" from "we spent more".
**Decision:** A new `budget` module/app (reads the ledger, posts nothing). A budget is 12 months from a
first month; `budget_lines` hold one account (+ optional cost center) with the 12 amounts as a JSON
array — always read and written whole, so no row per month. The flexible budget uses a sales activity
index (actual ÷ budgeted revenue); each cost flexes by the account's existing variable share
(`accounts.variable_bp`, cost of sales 100 % by default, interest and income tax never). An optional
`budget_sales` table (quantity per month, unit price, unit cost per item) gives price, mix, quantity and
volume variances on budget contribution, from posted invoices and credit notes. Approval
(`budget.budgets.approve`, SoD with `write`) locks a budget; changes go through reopen or a copy.
Overspends are ranked by the flexible-budget variance, not the total, so a volume effect is never
blamed on a manager.
**Consequences:** Works with any chart of accounts and without inventory; unit-level standard costing
(material/labour price and efficiency variances) stays out until there is manufacturing.

## ADR-014 · Cash forecast: computed on demand from open items, plus a small plan table
**Status:** Accepted · 2026-09-27
**Context:** A small company's first money question is "will we have enough cash next month?" Most of
the answer is already in the books (open invoices, bills, purchase orders); the rest (payroll, rent,
loans, tax) is not an invoice yet.
**Decision:** A `cashflow` module/app that stores only what is not in the books — `cash_plan` (planned
receipts/payments with a repeat rule) and one settings row (minimum cash, customer habits on/off,
doubtful threshold) — and computes the forecast on every request (pure `engine.ts`). Customer invoices
are expected at due date + the customer's amount-weighted delay over the last year; invoices overdue
beyond the threshold are listed "at risk" and left out; overdue items land in the first period; cash
lines already dated in the future count as "post-dated". It reads other modules' tables only.
**Consequences:** Always current, nothing to reconcile; a forecast is not saved (a snapshot can be
exported). Monthly repeats keep the day and clamp to month end.

## ADR-015 · Manufacturing: production through the inventory service, normal costing in the books
**Status:** Accepted · 2026-09-27
**Context:** Standard costing variances (materials price/usage, labour rate/efficiency, overhead) are
expected by management accountants, but the stock ledger is moving-average actual cost.
**Decision:** A `manufacturing` module/app (needs Inventory). Recipes (`boms`, `bom_lines`) hold the
standard; a production order snapshots it (`std` JSON) so later recipe edits never change old variances.
Completing an order calls a new `inventory.produce()` (contract): components leave at moving average,
the product enters at materials + labour + overhead applied (labour and overhead credited to two
"absorbed" cost-of-sales accounts, created on first use), in one balanced entry. Books are at normal
cost (actual materials and labour, overhead at the standard rate on actual hours); variances against
standard are computed for reports, not posted. The period report compares overhead applied with the
actual overhead accounts chosen in settings (spending / efficiency / volume, under/over-absorbed).
Reversal goes through `inventory.reverseProduction()`.
**Consequences:** No WIP account or multi-step routing yet; a back-dated purchase that re-costs a
component after production adjusts cost of goods sold, not the finished product.

## ADR-016 · Fixed assets: schedules computed, depreciation lines stored per month
**Status:** Accepted · 2026-09-27
**Decision:** A `assets` module/app. The schedule of an asset is a pure function of its cost, residual
value, life, method and opening depreciation (`engine.ts`); only what was booked is stored — one
`depreciation_lines` row per asset and month (by a monthly run, or at disposal). A run books every
pending month up to the chosen one in one entry (expense by cost center, accumulated depreciation by
category); only the latest run can be undone, and not across a later disposal. Depreciation is charged
for whole months, from the month of use through the month of disposal. Web pages live at
`/fixed-assets` because `/assets` is where the built bundles are served.
**Consequences:** No revaluation or impairment yet; changing an asset after depreciation is limited to
descriptive fields (dispose and re-register to correct).

## ADR-017 · Payroll: country-neutral components, one entry per month
**Status:** Accepted · 2026-09-27
**Decision:** A `payroll` module/app. Nothing about a country's law is built in: the company defines
components (earning / deduction / employer; fixed, % of basic, % of gross, or income tax on annual
brackets with an exemption and pre-tax deductions; optional ceiling on the base). A monthly run
computes each payslip (proration by calendar days, one-off bonus and deduction) and stores it as JSON
lines; posting books one entry at month end (expenses by account and cost center, net pay to
"Salaries payable", deductions and employer contributions to their liability accounts); paying books
the bank side. Draft → posted → paid, each step reversible in order. Payroll rights are separate
(`payroll.*`) with SoD between editing employees and posting runs.
**Consequences:** No leave/attendance module; statutory reports are exports of the run.

## ADR-018 · Cheques settle documents; the holding account carries them until clearing
**Status:** Accepted · 2026-09-27
**Decision:** A `cheques` module/app. A received cheque debits "Cheques receivable" and credits the
customer, settling invoices at once (settlement source `cheque` — documents migration 006 widens the
source types); clearing moves it to the bank; a bounce (or return / cancellation of an issued cheque)
reverses the party side and unsettles the documents. Issued cheques mirror this through "Cheques
payable". Cheques are in the company currency only and are never deleted (status history). The cash
forecast reads open cheques at their due date.
**Consequences:** Endorsing a customer's cheque to a supplier and foreign-currency cheques are left for later.

## ADR-019 · Recurring documents: templates replay through the owners' services
**Status:** Accepted · 2026-09-28
**Decision:** A `recurring` module keeps templates (the document or entry as JSON, a schedule) and makes
each occurrence through `documents.create/post` (new in the contract) or `ledger.createEntry`, so every
rule of those modules applies. A template is saved only after a trial run inside a rolled-back
transaction. Occurrences are counted (`done_count`), not dated, so a failure never skips a date; once
anything was made, the type and schedule are frozen (end it and start a new one). Generation is manual
(button, dashboard) — no background job on a LAN server that may be off.
**Consequences:** A template stores its lines, not a link to a source document; editing it changes future
occurrences only.

## ADR-020 · Import from Excel: a dependency-free reader, trial run first, all or nothing
**Status:** Accepted · 2026-09-28
**Decision:** An `imports` module reads `.xlsx` with a small zip + XML reader on `node:zlib` (no new
dependency) and `.csv` (UTF-8 or Windows-1256). Rows are written through the owners' services
(`ledger.createAccount`, `parties.create`, `catalog.createItem`, `ledger.createEntry`) — so every rule and
permission applies — each in its own savepoint inside one transaction: the preview rolls it back and
reports every row, the import commits only when no row failed. Existing codes are skipped, not updated.
**Consequences:** Updating existing records from a file, and importing documents (open invoices), are left
for later; opening customer balances go through the opening entry with party codes.

## ADR-021 · E-invoicing (Egypt ETA) as a separate module; signing by an external signer
**Status:** Accepted · 2026-09-28
**Decision:** An `einvoice` module/app listens to `document.posted` and only queues (no network inside the
posting transaction). Sending builds the ETA JSON from the posted document, serializes it canonically,
hashes it (SHA-256) and asks the taxpayer's signer (a local HTTP service holding the USB token — CAdES-BES
needs the token's PKCS#11 driver, which does not belong in the server) for the signature; then OAuth
client-credentials, `documentsubmissions`, and status reads by uuid. Addresses and credentials are
settings of the module; product codes and tax types are mapped in its own tables. One send or refresh at a
time. The server never edits a posted document: corrections go through credit notes, cancellations
through the ETA.
**Consequences:** Receipts (B2C e-receipt) and ZATCA are other modules on the same pattern. The client
secret is stored in the company database and never sent back to the browser.

