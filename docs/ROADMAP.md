# Mizan — Implementation plan

The plan is built in layers. Each layer is usable on its own and every later
layer plugs into the same module contract, so nothing built earlier is thrown
away.

## ✅ Phase 1 — Accounting core (this delivery)

- [x] Kernel: SQLite (WAL), migrations per module, typed services, events, integer money
- [x] Users, roles, sessions, audit trail, settings, gap-free numbering, backups
- [x] First-run setup wizard (company, currency, fiscal year, chart template, VAT, admin)
- [x] Bilingual chart of accounts (tree, groups, categories, default accounts)
- [x] Journal entries: draft → post → reverse; opening balances; DB-enforced integrity
- [x] Fiscal years, lock date, year-end closing & reopening
- [x] Customers & suppliers with statements of account and credit limits
- [x] Products & services, taxes (VAT, tax-inclusive pricing)
- [x] Sales invoices, credit notes, purchase bills, debit notes (auto-posted)
- [x] Receipts & payments with allocation, refunds, direct income/expense
- [x] Reports: trial balance, general ledger, income statement, balance sheet,
      cash flow, AR/AP aging, VAT summary, dashboard
- [x] Web app: EN/AR (RTL), light/dark, command palette, printing, CSV, mobile
- [x] End-to-end test suite for the ledger and every posting path

## ✅ Phase 2a — Inventory

- [x] Multiple warehouses, default warehouse, transfers
- [x] Perpetual stock ledger with running balances (item card)
- [x] Moving weighted-average cost; automatic cost-of-goods entries
- [x] Returns at original cost, supplier returns and voids trued-up in the ledger
- [x] Adjustments, opening stock, physical counts (differences only)
- [x] Negative stock impossible (database constraint), live availability in invoices
- [x] Item categories, barcodes, reorder level & quantity, per-item inventory/COGS accounts
- [x] Reports: stock on hand, valuation reconciled to the ledger, movement summary,
      reorder suggestions, item profitability; dashboard widget

## Phase 2b — Inventory, next level ✅

- [x] Units of measure with conversions (box of 12 → pieces)
- [x] Batches / lots with expiry dates (FEFO), serial numbers
- [x] Landed costs (freight, customs) spread over received goods
- [x] Back-dated postings with automatic cost revaluation
- [x] Price lists per customer group; minimum selling price guard
- [x] Purchase orders from the reorder report; goods received notes

## ✅ Phase 2c — Modular product & power lists

- [x] Apps: switch Sales, Purchases, Cash & bank, Inventory, Purchase orders, Price lists on or off per company
- [x] Setup wizard asks what the company needs; menus follow the apps
- [x] Per-module health checks with a System health page
- [x] Excel-like data grid on every list: per-column filters, grouping with subtotals, saved views
- [x] Menus across the top as an alternative to the sidebar

## ✅ Phase 2d — Professional modules, roles, editions, docs

- [x] Finance split like SAP/Odoo: GL, AR, AP, Treasury, Tax, CO as separate apps
- [x] Contracts and registries so each module can be removed; boundary tests (server + web)
- [x] Users & roles: permission matrix, role templates, several roles per user, duty-split warnings
- [x] Cost centers as a dimension on journal and document lines; P&L per cost center
- [x] Editions: build and test a copy with only the chosen apps
- [x] Documentation system: generated program map, changelog, decisions, lessons, CLAUDE.md rules

## Phase 2 — Operations

- [x] **Banking**: bank transfers between accounts, bank reconciliation,
      statement import (CSV)
- [x] **Multi-currency**: document currency + exchange rate, realised /
      unrealised FX gains & losses
- [x] **Financial analysis app**: full statement set, 50 ratios, DuPont, break-even, distress score, notes
- [x] Budgets and variance analysis (flexible budget, price / volume / mix variances)
- [x] **Cash forecast**: 13 weeks / 12 months from open invoices and bills (customer payment habits), purchase orders, planned items and post-dated entries; minimum-cash alert
- [x] **Manufacturing**: recipes (BOM) with standard costs, production orders through stock, material / labour / overhead variances
- [ ] Projects as a second dimension next to cost centers; budgets per cost center
- [ ] Recurring invoices and journal templates
- [ ] Quotations → sales orders → invoices; purchase orders → bills

## Phase 3 — Business modules

- [x] **Fixed assets**: register, depreciation schedules, automatic postings
- [x] **Payroll** (basic): employees, salary components, monthly posting
- [x] **Cheques** (post-dated cheques receivable / payable — common in the region)
- [ ] E-invoicing adapters (e.g. Egyptian ETA / Saudi ZATCA) as separate modules

## Phase 4 — Platform

- [ ] Attachments on documents (scans of receipts)
- [ ] Import from Excel (chart of accounts, parties, opening balances)
- [ ] Multi-company (one database file per company, switcher in the UI)
- [ ] HTTPS on the LAN (self-signed certificate helper)
- [ ] Desktop packaging (Windows service / tray app) for one-click install
- [ ] Optional encrypted off-site backup target

## Principles for every new module

1. It owns its tables and migrations; it never writes another module's tables.
2. It posts to the books **only** through `services.get('ledger')`.
3. It declares its permissions (`module.object.action`), role templates and audit-logs every write.
4. It ships its web module (nav, pages, commands) and both translations.
5. It comes with tests proving the books still balance.
6. It talks to other modules only through contracts, services, events and registries,
   is listed in `scripts/edition.mjs`, and passes `npm run edition -- <its app> --check`.
7. It updates the docs in the same commit (see `CLAUDE.md`).
