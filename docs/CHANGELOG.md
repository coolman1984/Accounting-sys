# Changelog

All notable changes, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).
Every change adds a line under **[Unreleased]** in the same commit.

## [Unreleased]

### Added
- **Backup rehearsal (WP-X3)** — `POST /api/system/backups` now opens the new copy read-only and reports a rehearsal (structure check, no dangling references, every posted journal entry balances, row counts of the main tables); `POST /api/system/backups/:name/verify` repeats it on any earlier backup. A failed rehearsal is written in the audit line. Same rule as GMES and HR: a copy nobody opened is not a backup.
- **KPI pack and executive S&OP (WP-M6, API)** — `GET /api/kpi/pack?month=YYYY-MM`: delivery service level (OTD, OTIF, fill rate of the lines due in the month, measured as of the month end or today), forecast accuracy and bias with a lag of one month (plan of the cycle before vs invoiced quantity net of credit notes, per item), sales against the plan in money. A figure that cannot be measured is null, never 0 or 100 %. `GET /api/sop/versions/:id/executive`: demand, budget and supply gap in money per month and the five biggest supply shortfalls with their constraint; demand without any supply plan is counted as unknown, not as short. Turns, DSO/DIO/DPO, margin by model, PPV, production variances and payroll per set are listed as not measured here. No screen yet.
- **Injectable clock (WP-M7)** — `buildApp(config, modules, { clock })`: every date and timestamp of the server (today's defaults, lock dates, due dates, sessions, event versions) reads `kernel/dates.ts` (`today`, `nowIso`, `nowMs`, `currentDate`), which follows the clock given; without one it is real time. A test fails if a module reads `new Date()` or `Date.now()` directly. The scenario engine uses it to drive simulated days.
- **Demo company** — a Samsung Electronics Egypt–style TV / phone / tablet factory, 1 Jan – 25 Sep 2026:
  ~300 documents, ~250 receipts/payments/cheques, 90 production orders, 135 employees, imports in USD
  with customs and import VAT, zero-rated exports, withholding, cheques, payroll, depreciation, FX
  revaluation, budget and a reconciled bank statement. Built through the HTTP API by `npm run demo`
  into `data-demo/` (never over an existing company); `start-demo.bat` runs it on port 4810; a test
  checks that it ties. Facts and limits: `docs/research/DEMO-SAMSUNG-EGYPT.md`.
- **Egyptian withholding tax (خصم وإضافة)** on receipts and payments: deducted from suppliers on the value
  before VAT (1% supplies/contracting, 3% services, 5% commissions, 300 EGP minimum, editable) and due with
  Form 41; tax withheld by customers kept as a credit against income tax; suggestion from the party's type;
  Withholding report reconciled to the books.
- **Egyptian payroll**: salary tax of Law 7/2024 (with the high-income rule and rounding to 10 pounds),
  social insurance on the declared insurable wage between the year's minimum and maximum, one-click setup.
- **Advisor** (new `advisor` app): daily checks against Egyptian VAT, withholding, payroll, income tax and
  company law and the Egyptian Accounting Standards, each with the rule behind it and how to fix it;
  shown on its page, on the dashboard and on invoices and bills.
- Chart: withholding accounts (1180, 2190) and the legal reserve (3150).
- **Recurring documents** (new `recurring` app, in General ledger): templates that make sales invoices,
  supplier bills or journal entries every week, month, quarter or year (every N), from a first date to an
  end date or a number of times; month ends kept (31 Jan → 28 Feb → 31 Mar); `{month}`, `{year}`, `{date}`
  filled into notes and memos; posted automatically or left as drafts. Each template is checked by a trial
  run when saved; missed dates are caught up in order, a failure stops that template without skipping a
  date, and nothing is made twice. "Repeat this" on an invoice or bill starts a template from it; the
  dashboard lists what is due with one button to make it.
- **Import from Excel** (new `imports` app, in Administration): customers & suppliers, products & services,
  the chart of accounts and opening balances from `.xlsx` or `.csv` (Arabic Windows CSV understood).
  Downloadable templates in English or Arabic; columns matched by English or Arabic names; Arabic digits
  and thousands separators accepted. Every file is first checked by a trial run that reports each row's
  problem in the reader's language; nothing is imported until every row is right, then all in one
  transaction. Existing codes are skipped, parents may come after their children, opening balances post
  one balanced entry (once).
- **E-invoicing for Egypt** (new `einvoice` app, in Tax, needs Receivables): posted sales invoices and
  credit notes are queued, built as ETA documents (v1.0 signed or 0.9 for pre-production), signed by the
  taxpayer's local signer (USB token), submitted, and their result read back (accepted, refused with the
  ETA's reasons, cancelled). Readiness checks before sending (registration, addresses, product codes, tax
  types, national ID above 50,000 EGP, credit note's original accepted, no future dates); product EGS/GS1
  codes and tax types mapped once; cancel at the ETA from the invoice; status panel on every invoice.
- Services for other modules: `catalog.createItem`, `parties.create`, `documents.create` / `documents.post`.
- **Fixed assets** (new `assets` app, "Fixed assets (AA)" menu): categories from the chart (furniture,
  vehicles, computers) with their accounts; register with cost, residual value, useful life, straight
  line or declining balance, assets brought in part-depreciated; optional purchase entry; monthly
  depreciation in one entry per month (missed months caught up, latest run can be undone); disposal or
  sale charging depreciation to the month of sale with the gain or loss; movements report (cost and
  depreciation, opening + additions − disposals = closing) per category.
- **Payroll** (new `payroll` app, "People & payroll (HR)" menu): employees with hiring/leaving dates and
  basic salary; pay components — earnings, deductions and employer contributions as fixed amounts or
  percentages (with a ceiling), income tax on annual brackets with an exemption and pre-tax deductions;
  monthly runs with days-worked proration, one-off bonuses and deductions, entry preview, posting by cost
  center, salary payment from a bank or cash account, printable payslips.
- **Cheques** (new `cheques` app, in Treasury): post-dated cheques received and issued; a cheque settles
  invoices or bills on receipt and waits in "Cheques receivable / payable" until the bank clears it;
  deposit, clearing (and undo), bounced / returned / cancelled cheques reopen what they paid; portfolio by
  due date. The cash forecast now includes open cheques and unpaid payrolls.
- `ledger.ensureAccount()` creates an account a feature needs under its usual group when the chart lacks it.
- **Cash forecast** (new `cashflow` app): cash and bank today, then 13 weeks or 12 months of expected
  receipts and payments — open invoices (moved by each customer's real payment delay), bills, open
  purchase orders, planned items (payroll, rent, loans, tax, with repeats) and post-dated entries;
  lowest point, first shortfall under the minimum cash, funding needed, doubtful invoices listed apart;
  regular payments found in the books are suggested as planned items.
- **Manufacturing** (new `mfg` app, needs Inventory): recipes with materials (+ scrap), labour and
  variable/fixed overhead rates and their standard cost; production orders that consume materials and
  add the product at full cost in one entry (reversible); variances for material price and usage, labour
  rate and efficiency, overhead efficiency; period report with overhead applied vs actual (spending,
  efficiency, volume, under/over-absorbed). New "Production (PP)" menu section.
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
- The payments health check flagged every payment with withholding as over-allocated (it compared the
  allocations with the amount paid, not paid + withheld).
- **Windows**: `start.bat` / `start.sh` now build on every start, so pulled code never runs from an old build;
  the tests import files by `file://` URL (a `D:\…` path is not a valid ESM specifier); the `docs/MAP.md`
  check ignores CRLF line endings from a Windows checkout.
- `ensureDefaultAccount` could take another account that held the template's code; it now needs the same name.
- **Cheques could be booked to the VAT input account**: "Cheques receivable" was created with code 1150,
  which the standard chart already uses for VAT input, and `ensureAccount` took any account with the same
  code and type. It now only reuses an account with the same name, cheques use 1155, a migration forgets
  the wrong choice where no cheque was booked yet, and a new health check reports it otherwise.
- System health showed raw keys for fixed assets, payroll, manufacturing and cheques checks (a test now
  requires every check's words in both languages).
- A recurring template whose draft invoice had been deleted could not be opened.
- Invoices settled by a cheque link to the cheque (settlement source `cheque`).
- Journal entries of bank transfers opened a stock operation; goods receipts, landed costs, bank
  statements and production orders now link to their own page.
- A receipt or payment for a party that is only a customer (or only a supplier) no longer asks which one.
- Reversing an entry, voiding a document or closing the year failed when one of its accounts had been
  deactivated since; copies of posted entries now keep their accounts (new postings are still refused).
- Editing one field of a user (e.g. the name) reactivated a deactivated user and reset their language
  (zod 4 applies defaults inside `.partial()`); a username clash on edit is now a clear message.
- Database guards of inventory, purchasing and manufacturing (and duplicate values) answered
  "Unexpected server error"; every guard now returns its reason (409).
- A credit note whose invoice was voided while it was a draft is refused with a clear message.
- Dashboard cash per account counted entries dated in the future (total and breakdown now agree).
- Login answers in the same time whether or not the username exists; the failed-attempts list is bounded.
- Purchase order lines refuse a unit of measure without an item.
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
