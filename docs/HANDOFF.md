# HANDOFF — finish this first

The previous session ran out of time in the middle of a large request. **The next agent finishes
everything below, in this order, before starting anything new**, then deletes the finished items from
this file (and the file itself when it is empty, removing the pointer in `CLAUDE.md`).

Last state: all work is committed on `main` (merged with PR "Egyptian tax rules, the advisor…").
Typecheck clean, 177 server tests pass, `docs/MAP.md` current.

---

## 0. Working with this user (keep exactly)

- **Replies**: Egyptian Arabic, short, dense, logically ordered, written for a **non-technical** reader,
  with fitting emojis. **Never mix English words into the Arabic.** The user writes Arabic or English; always
  answer in Egyptian Arabic.
- **Git**: develop on `claude/accounting-system-core-pxx8tx`. If its PR was merged, restart it from `main`
  (`git fetch origin main && git checkout -B claude/accounting-system-core-pxx8tx origin/main`).
  Push with `git push -u origin claude/accounting-system-core-pxx8tx`.
- **The user said "merge without asking"**: when a piece is done and verified, open the PR and merge it
  (GitHub MCP tools; the merge needs the full 40-char head SHA). Repo: `coolman1984/accounting-sys`.
- Commit trailer and PR footer: use the attribution lines given by the harness for the session.
  Never put model names in commits, code or PRs.
- Follow `CLAUDE.md` (definition of done: typecheck, tests, docs:map, CHANGELOG, LESSONS, DECISIONS…).
- The audience: the user will demo to **senior accountants who will try to find mistakes**. Every number
  must be right and explainable; Egyptian law and the Egyptian Accounting Standards (EAS, IFRS-based)
  must be followed; say "confirm with your tax adviser" where a figure changes yearly.

## 1. What the user asked (the full request, in order of the user's own words)

1. Egyptian tax law applied **automatically**, with warnings when something breaks the law and **tips**
   when something may cause an IFRS/EAS problem, in simple Arabic and English. — **DONE** (see §2).
2. **Help / explanations**: for every screen: what it does, **what posts to what, where each number comes
   from and goes**, how it is calculated. — **IN PROGRESS** (§3.1).
3. **Guide mode** (وضع المرشد): a setting that turns the explanations/warnings/tips **off, basic or full**. (§3.2)
4. **Junior mode** (وضع المحاسب الجديد) — the user says nobody has built this before, it is a selling point:
   the admin switches it on for a new accountant who does not know the system or the company's accounts.
   A **side panel that slides in and out** (beautiful) that explains everything as they work — where every
   amount comes from and goes to, **on this company's own accounts** — plus a **search "how do I …"**
   that finds a task and **walks the user through it step by step across the screens** (guided tour). (§3.3)
5. **Research the internet** for ideas like this (in-app guidance / digital adoption) and improve on them. (§3.3)
6. A **strong review of how the menus and features connect** (information architecture), and explain the
   connections too. (§3.4)
7. An **interactive user manual** in very simple language, "as if you are not an accountant", that also
   teaches how to get the most out of the system. (§3.5)
8. **Excel-like tables everywhere**: filters, sort, grouping, subtotals, many features, and **download any
   table as a real Excel file**; everything beautiful. (§3.6)
9. **OCR**: read scanned or photographed invoices, detect the text and numbers by itself, and **always ask
   the user to confirm** the numbers and words before saving. (§3.7)
10. **Demo company** with realistic, internally consistent sample data that can be explained line by line. (§3.8)
11. An **auditor-style review** of everything, then docs, PR, merge. (§3.9)

## 2. Done in the previous session (do not redo)

- **Withholding tax (خصم وإضافة)** on receipts/payments: `payments` columns `wht_type/base/rate_bp/amount`
  (migration `003_withholding`), journal: out → Cr 2190 *Withholding Tax Payable (Form 41)*; in → Dr 1180
  *Withholding Tax Deducted by Customers*. Rates in `tax.withholding()` (settings key `withholding`,
  defaults 1% supplies/contracting, 3% services, 5% commissions, minimum 300 EGP), `POST /payments/withholding`
  suggestion (base = allocation × subtotal ÷ total, i.e. before VAT), `GET/PUT /tax/withholding`,
  `GET /reports/withholding?side=deducted|suffered` (reconciled to the books). Parties have `wht_type`.
  Web: payment editor card, payment view, party dialog, Tax › Withholding tax page (`modules/tax/withholding.tsx`).
- **Payroll Egypt**: `egyptSalaryTax()` (Law 7/2024 brackets, high-income rule above 600k, rounding down to
  10 EGP) in `payroll/engine.ts`; components `floor`, `insurable`, `tax_rule='eg_2024'`; employees
  `insurable_wage`; `POST /payroll/components/egypt` creates SI 11% / 18.75% (accounts 2141, 5211) and
  salary tax (2142). Constants in `contracts/egypt.ts` (**the 2026 insurance limits 2,700 / 16,700 must be
  confirmed** against the NOSI circular).
- Chart: 1180, 2190, 3150 *Legal Reserve* added; `ensureAccount`/`ensureDefaultAccount` reuse an account
  only when the **name** matches (the 1150 VAT-input collision bug).
- **Advisor** module (`modules/advisor`, app `advisor`, perm `advisor.findings.read`): 22 checks in
  `checks.ts` (VAT without supplier TIN, customer ID ≥ 50k, VAT return due/credit, VAT registration
  threshold, WHT not withheld / type missing / Form 41 due / credit, payroll insurable wage / limits / tax
  due / insurance due, income tax provision 22.5%, return deadline, legal reserve 5% up to 50% of capital,
  year not closed, ECL > 90 days (EAS 47), lease rent (EAS 49), NRV (EAS 2), depreciation behind (EAS 10),
  negative cash, old drafts). Texts `advisor.checks.<id>.{title,body,fix,law}` in both dictionaries.
  Web: `/advisor` page, dashboard widget, advice on invoices/bills (`document.view` slot).
- Tests: `apps/server/src/test/egypt.test.ts` (7 tests with worked examples).
- Groundwork for help: `HelpTopic` in `core/registry.ts` (`WebModule.help`), `useHelpTopics()` and
  `helpFor(topics, path)` in `core/slots.tsx`.
- Tool: `scripts/i18n-insert.py` — inserts text into a nested block of `en.ts`/`ar.ts` by key path
  (`both(['pay'], en_text, ar_text)`, `both([], ...)` for a new top-level section). Run prettier after
  (`npx prettier --single-quote --print-width 240 --write src/core/locales/*.ts` in `apps/web`).

**Not yet in the docs** (add when you next commit): CHANGELOG lines for withholding, Egyptian payroll and
the advisor; ADR-022 "Egyptian rules as defaults in `contracts/egypt.ts`, withholding on payments, the
advisor reads and never writes"; LESSONS: "`find or create` by code alone borrowed the VAT account".

## 3. Remaining work — in this order

### 3.1 Help center (finish first)

- `ui/HelpArticle.tsx`: renders one topic from `help.topics.<id>`: sections *What it is for* (`what`),
  *How to use it* (`steps`), *What it posts* (`entries`), *How it is calculated* (`calc`),
  *Egyptian rules & standards* (`rules`), *Tips* (`tips`). Values are strings; lines split on `\n`;
  an empty string hides the section. In `entries`, lines starting with `Dr` / `من ح/` are debits,
  `Cr` / `إلى ح/` credits (indented), lines ending with `:` are headings — show it like a T-entry.
- A `help` web module (`modules/help`, add to `scripts/edition.mjs` with `requires: []`) declaring all topics
  (`help: HelpTopic[]` with routes and app gates), routes `/help` (groups, search) and `/help/:id`.
- AppShell: a "?" button in the top bar and **F1** open a slide-in drawer with `helpFor(topics, pathname)`
  and a link to the full help center.
- Topics (id → routes): dashboard `/`; basics (how the books work: double entry, drafts vs posted,
  void/reverse, lock date); egypt (overview of the Egyptian rules); month_end checklist; year_end
  (closing entry: income & expense → retained earnings 3200; legal reserve; tax provision); accounts
  `/accounts`; journal `/journal`; trial_balance `/reports/trial-balance`; statements
  `/reports/income-statement`, `/reports/balance-sheet`, `/reports/cash-flow`, `/reports/equity-changes`;
  settings `/settings` (fiscal years, lock date, default accounts, backups); access `/access`; apps `/apps`;
  health `/system/health`; audit `/audit`; sales_invoice `/sales/invoices`; credit_note `/sales/credit-notes`;
  customers `/customers`; price_lists `/sales/price-lists`; aging `/reports/aging/receivable`,
  `/reports/aging/payable`; receipts `/receipts`; bills `/purchases/bills`; debit_notes
  `/purchases/debit-notes`; suppliers `/suppliers`; payments `/payments`; purchase_orders `/purchasing/orders`;
  goods_receipts `/inventory/receipts`; landed_costs `/inventory/landed-costs`; bank `/bank`;
  transfers `/bank/transfers`; cheques `/cheques`; vat `/taxes`, `/reports/tax`; withholding
  `/reports/withholding`; einvoice `/einvoice`; advisor `/advisor`; items `/items`; stock `/inventory`,
  `/inventory/operations`, `/inventory/warehouses`; manufacturing `/mfg`; fixed_assets `/fixed-assets`;
  payroll `/payroll`; budget `/budgets`; cashflow `/cashflow`; analysis `/analysis`; fx `/currencies`,
  `/fx/revaluation`; cost_centers `/cost-centers`, `/reports/cost-centers`; recurring `/recurring`;
  import `/import`.
- **What each document posts** (verified in the code — write the help from this):
  - Sales invoice: Dr receivable (party's, default 1130) = total; Cr each line's account (item income account,
    else Sales 4100 / Services 4200) = value after discount; Cr VAT output (the tax's sales account, 2120).
    Stock items (Inventory on): second entry Dr COGS 5100 / Cr Inventory 1140 at moving-average cost.
  - Credit note: the mirror; against an invoice it settles it at once; returned stock comes back at the
    cost it left at.
  - Supplier bill: Cr payable (2110) = total; Dr lines: stock item → Inventory (or GRNI 2160 if already
    received on a goods receipt), otherwise the item's expense account or Purchases 5150; Dr VAT input 1150.
  - Receipt: Dr cash/bank; Cr receivable; withholding → Dr 1180; foreign invoices → realised FX gain/loss
    (4950 / 5850). Payment: Dr payable; Cr cash/bank; withholding → Cr 2190.
  - Goods receipt: Dr Inventory / Cr GRNI; the bill clears GRNI (price differences to inventory, or to cost
    of sales for what was already sold). Landed cost: Dr Inventory (on-hand share) + Dr COGS (sold share) /
    Cr the chosen counter account.
  - Stock operations: adjustment/count vs Inventory adjustments 5160 (or chosen account); opening stock vs
    Capital; transfers between warehouses keep the company-wide average cost.
  - Cheques: received → Dr Cheques receivable (1155) / Cr customer; cleared → Dr bank / Cr 1155; bounced →
    reverses the customer side and reopens invoices. Issued mirror via Cheques payable (2155).
  - Transfer: Dr destination / Cr source (+ fee account; FX difference if currencies differ).
    Bank reconciliation: a statement line without an entry creates Dr/Cr bank vs the chosen account.
  - Depreciation (monthly run): Dr Depreciation expense 5290 / Cr Accumulated depreciation 1290 (per
    category accounts); disposal: remove cost and accumulated depreciation, proceeds, gain 4920 / loss 5920.
  - Payroll post: Dr salaries expense (5210, by cost center) + employer contributions; Cr salaries payable
    2140, deduction liabilities (2141 insurance, 2142 salary tax). Payment: Dr 2140 / Cr bank.
  - FX revaluation: open foreign balances to the month-end rate vs unrealised gain/loss, reversed next day.
  - Production order: Dr finished goods inventory / Cr materials inventory + applied labour/overhead.
  - Year-end closing: income and expense balances to Retained earnings 3200 (reopening reverses it).
  - Recurring templates make ordinary invoices/bills/journal entries (source `manual` for journals).

### 3.2 Guide mode (setting)

- Company setting `guideMode: 'off' | 'basic' | 'full'` (settings service key, Settings › General), and a
  per-user override. `basic` = warnings only; `full` = warnings, inline tips on forms, "where this comes from"
  hints on totals. All advice components read it via a `useGuide()` hook in `core/`.

### 3.3 Junior mode + guided tours (research first)

- Research on the internet: digital-adoption tools (WalkMe, Pendo, Whatfix, Userpilot, Appcues, Intercom
  product tours), open-source tour libraries (driver.js, Shepherd.js, Intro.js — check licences; driver.js
  is MIT), Odoo onboarding, QuickBooks/Xero in-app help, "explain this number" features. Write findings in
  `docs/research/GUIDANCE.md` and an ADR before building.
- Admin setting per user `junior: boolean` (Settings › Users). When on: a right/left (RTL-aware) **slide
  panel** that opens beside every page: what the page does, the entry it will post **with this company's
  real account codes and names** (read defaults and the chosen accounts), where each total on the page comes
  from (click a number → "made of …"), and the next usual step.
- "How do I …" search over tasks (e.g. "record a customer payment with withholding", "close the month",
  "pay salaries"): each task is a list of steps `{route, selector, text}` played as a guided tour that
  continues across page changes (store progress in sessionStorage). Tasks and texts in both dictionaries.

### 3.4 Menus and connections review

- Walk every menu section; check order, names, duplicates, dead ends, missing links between related pages
  (invoice ↔ entry ↔ payment ↔ cheque ↔ e-invoice ↔ advisor…). Fix, and add a "Related" strip on pages.
  Explain the flow in a help topic "How everything connects" with a diagram (sales, purchases, stock,
  cash, tax, payroll, assets → the ledger → reports).

### 3.5 Interactive user manual

- Help center topics written in very simple words (no jargon; when a term is needed, explain it once),
  plus "get the most out of Mizan" topics (command palette Ctrl+K, grid features, saved views, shortcuts,
  recurring, import, advisor). Links from each topic to the page and to its guided task.

### 3.6 Excel-like grids everywhere

- `ui/DataGrid.tsx` already has per-column filters, grouping with subtotals, saved views, column chooser,
  CSV export. Add: **real .xlsx export** (port `apps/server/src/modules/imports/xlsx.ts` `writeXlsx` to a
  shared web lib or call a server endpoint), totals row, sort by several columns, freeze first column,
  copy selection. Replace remaining plain `<table>` lists with DataGrid (reports keep their layouts but get
  the Excel button).

### 3.7 OCR for invoices

- Offline on the LAN: `tesseract.js` with `ara` + `eng` trained data **served locally** (no internet at
  runtime) — new dependency → ADR. Also try the ETA e-invoice QR code if the image has one (it holds the
  UUID; the portal link gives the data).
- Flow: upload image/PDF (PDF → first page image) on a supplier bill → OCR → parse supplier tax number
  (9 digits), invoice number, date, subtotal, VAT 14%, total, lines → prefill a **draft** bill → the user
  confirms/corrects every field (show the image beside the form, highlight low-confidence fields) → save.
  Never post automatically. Arabic-Indic digits normalised.

### 3.8 Demo company

- A seeder that uses the app's own HTTP API (`app.http.inject`, like `test/helpers.ts`), so every number
  comes from the real engine: offered in the setup wizard ("Start with a demo company") and as
  `npm run demo`. Company: an Egyptian trading & services company, FY 2026 (Jan–Sep): capital, a bank
  loan, fixed assets with monthly depreciation, stock bought and sold at 14% VAT, withholding on supplier
  payments and by customers, cheques, bank reconciliation, Egyptian payroll (one-click components,
  insurable wages), e-invoices (queued only), budget, recurring rent (a short lease, to avoid the EAS 49
  tip — or keep it to show the tip, decide), cost centers.
- A test builds it and asserts: trial balance balances; health all OK; VAT report = VAT accounts;
  withholding report = its accounts; payroll = the law's worked examples; inventory valuation = ledger;
  the advisor shows only tips (no errors/warnings) unless intentionally shown.
- Browser pattern: `/tmp` scripts are gone; recreate a Playwright script like the last one (launch with
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`, POST `/api/setup`, log in, call the
  API, take screenshots in EN and AR). Server for manual runs: `MIZAN_DATA_DIR=<tmp> MIZAN_PORT=4830 npm start`
  after `npm run build`.

### 3.9 Auditor-style review, docs, PR, merge

- Walk the demo as a senior Egyptian accountant: every statement ties (TB, BS = L + E, cash flow
  reconciles to cash, VAT, WHT, payroll, depreciation, stock), advisor texts correct, Arabic wording.
- Update CHANGELOG, DECISIONS, LESSONS, ROADMAP, ARCHITECTURE; `npm run docs:map`; typecheck; tests;
  editions (`node scripts/edition.mjs advisor --check` etc.); browser smoke of all pages EN/AR; PR; merge.
- Final reply to the user: short Egyptian Arabic summary with screenshots.

## 4. Facts to double-check (flag them in the UI where relevant)

- Social insurance 2026 minimum/maximum insurable wage (2,700 / 16,700 assumed).
- Withholding rates (1% / 3% / 5%) and the 300 EGP minimum — per the executive regulations in force.
- Deadlines used by the advisor: VAT return within the month after the period; Form 41 in January, April,
  July, October; salary tax within the first 15 days of the next month; corporate return within 4 months.
