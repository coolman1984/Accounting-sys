# Changelog

All notable changes, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).
Every change adds a line under **[Unreleased]** in the same commit.

## [Unreleased]

### Added
- **Professional modules** like SAP/Odoo: General ledger (GL), Receivables (AR), Payables (AP),
  Treasury, Tax and Controlling (CO, cost centers) are separate modules and separate apps,
  next to Inventory, Purchase orders and Price lists.
- **Users & roles** (Admin › Users & roles): roles stored in the database, several roles per user,
  a permission matrix per module (view / create & edit / post / approve / manage / override),
  role templates (sales clerk, cashier, storekeeper, controller …) and separation-of-duties warnings.
- **Cost centers** (CO app): tag income and expense lines on journal entries, invoices and bills;
  profit & loss per cost center; health check for orphan references.
- **Editions**: `npm run edition -- <apps|preset> [--check]` copies the program with only the chosen apps,
  rewrites the module lists and runs typecheck + tests on the result.
- **Documentation system**: generated program map (`docs/MAP.md`), decisions log, lessons, this changelog,
  `CLAUDE.md` rules, a docs test and a Stop hook that regenerates the map.
- Receivables / payables overview widgets on the home page; ageing pages per side.
- ERP research document (`docs/research/ERP-RESEARCH.md`).

### Changed
- Permission keys are now `module.object.action` (e.g. `ar.invoices.post`, `treasury.payments.post`);
  treasury receipts and payments are separate rights. Old app ids are migrated
  (accounting→gl, sales→ar, purchases→ap, banking→treasury).
- Tax codes moved from the catalog into the Tax module; with Tax off, lines carry no tax.
- Reports moved into the modules that own them (GL statements in ledger, tax summary in Tax, ageing in documents).
- Tax codes and cost centers are reference lists any signed-in user may read while their app is on.
- Web restructured: `core/`, `ui/`, `engines/` (shared documents and parties screens), `modules/<app>/`.
- Minimum-price override right renamed to `pricing.minprice.override`.

### Fixed
- Reversing a journal entry now keeps its cost centers, even after CO is switched off.
- Invoice editor showed no line when the Tax app was off.
- Purchase-order editor asked for a warehouse when Inventory was off.

## 2026-09-27 — Power lists, apps and health (PR #2)

### Added
- Excel-like data grid on every list: per-column filters, grouping with subtotals, saved views, CSV.
- Apps: switch features on and off per company; setup wizard asks what the company needs.
- Per-module health checks and a System health page.
- Menus across the top as an alternative to the sidebar.

### Fixed
- Issues found by browser testing and code review (static serving after rebuild, landed-cost voids,
  inventory listener with the app off, purchase-order tracking checks).

## 2026-09-27 — Advanced inventory (PR #1)

### Added
- Units of measure, lots with expiry (FEFO), serial numbers, goods receipts with GRNI,
  landed costs, back-dated recosting, purchase orders, price lists with a minimum price guard.

## 2026-09-26 — First release

### Added
- Modular kernel, double-entry ledger, customers & suppliers, products, taxes, invoices, bills,
  receipts & payments, financial reports, users & audit, backups.
- Bilingual web app (EN/AR, RTL), light/dark, command palette.
- Inventory: warehouses, perpetual stock, moving average cost, stock documents and reports.
