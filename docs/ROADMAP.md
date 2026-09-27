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

## Phase 2 — Operations

- [ ] **Banking**: bank transfers between accounts, bank reconciliation,
      statement import (CSV)
- [ ] **Multi-currency**: document currency + exchange rate, realised /
      unrealised FX gains & losses
- [ ] **Cost centers / projects** as a reporting dimension on journal lines
- [ ] Recurring invoices and journal templates
- [ ] Quotations → sales orders → invoices; purchase orders → bills

## Phase 3 — Business modules

- [ ] **Fixed assets**: register, depreciation schedules, automatic postings
- [ ] **Payroll** (basic): employees, salary components, monthly posting
- [ ] **Cheques** (post-dated cheques receivable / payable — common in the region)
- [ ] Budgets vs actuals
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
3. It declares its permissions and audit-logs every write.
4. It ships its web module (nav, pages, commands) and both translations.
5. It comes with tests proving the books still balance.
