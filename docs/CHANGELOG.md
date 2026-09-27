# Changelog

All notable changes, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).
Every change adds a line under **[Unreleased]** in the same commit.

## [Unreleased]

### Added
- **Budgets & variance analysis** (new `budget` app): monthly budgets by account (and cost center),
  started empty, from a copy, or from 12 past months with a growth rate (seasons matched by calendar
  month; unfinished months estimated); approval locks a budget (separate approve right). Budget vs actual
  in three columns — planned, plan flexed to actual sales, actual — splitting every difference into
  "due to sales level" and "due to prices & spending", with the worst overspends listed. Optional sales
  budget by item gives price, mix, quantity and volume variances on the planned margin.
- **Multi-currency** (new `fx` app, IAS 21 simplified): currencies and daily rates; invoices, bills,
  credit notes, receipts and payments in any currency with their own rate; bank/cash accounts kept in a
  foreign currency; realised exchange gains/losses booked with the payment; month-end revaluation of
  open foreign items and foreign cash (reversed next day); transfers across currencies; foreign-currency
  bank reconciliation; journal lines carry the foreign amount.
- **Full statement set**: analytical income statement (gross profit, operating profit, EBIT, interest,
  profit before tax, income tax, net profit, EBITDA memo), statement of changes in equity, common-size
  (vertical) view of the income statement and balance sheet, cash flow and equity in the GL menu.
- **Financial analysis** (new `analysis` app): 50 ratios in liquidity, solvency, efficiency, profitability,
  cash flow & growth, break-even & leverage and per-share groups — each with meaning, formula, status and
  the previous period; DuPont (3 and 5 parts); cash conversion cycle; Altman Z'' distress score;
  plain-language accountant's notes; data-quality checks; break-even what-if; monthly trend.
- Account settings for analysis: variable share % of each expense (cost behaviour) and a rent/lease tag.
- New account subtypes: short-term investments, short-term borrowings, dividends, interest expense,
  income tax; charts made earlier gain these accounts automatically.
- Research: `docs/research/FINANCIAL-ANALYSIS.md` (formulas, edge cases, built-in vs add-on decision).

### Fixed
- Health check for document settlements now also covers credit notes and base-currency amounts.

### Added
- **Banking** (Treasury app, new `bank` module):
  - transfers between cash and bank accounts, with bank charges, draft → post → void;
  - bank reconciliation: statements per account, CSV import with column guessing
    (English/Arabic headers, one signed or separate in/out columns, date format), automatic matching
    by amount and date (±10 days, reference first), manual match/unmatch, one-click entries for bank
    charges and interest, finish only when every line is matched and the balances agree;
  - reconciled statements are locked (database triggers) and their entries cannot be reversed until reopened;
  - "not at the bank yet" amount explains the gap between the statement and the books;
  - new rights `treasury.transfers.*` and `treasury.statements.*`; health checks for statements and matches.
- **Menus by professional module, like SAP:** General ledger (GL), Receivables (AR), Payables (AP),
  Treasury (TR), Tax (TX), Controlling (CO), Purchasing (MM), Inventory (IM), Analytics, Administration —
  each with its module code. Sections fold and unfold (remembered per computer); the section of the open
  page always stays open. Each module's own reports sit in its section (trial balance, ageing, VAT
  summary, profit by cost center). Same grouping in the top-menu layout.

## 2026-09-27 — Professional modules, roles, editions, docs (PR #3)

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
- Pages opened by link respect roles and apps: a clear "No access to this page" message
  (the gate follows the closest menu item or report tile).

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
- Opening a forbidden page by link showed an endless spinner.
- Role picker showed a role's name and description run together; administrators no longer get
  duty-split warnings (they hold everything by design).

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
