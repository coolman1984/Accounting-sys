# Financial analysis & multi-currency — research and design

Goal: a small company using Mizan gets what an experienced management accountant
would give it: correct multi-currency books, the full set of financial statements,
every standard analysis ratio with its meaning, and plain-language conclusions —
computed from the books with no spreadsheet work.

Sources: management-accounting professional curriculum on financial statement
analysis (liquidity, solvency, activity, profitability, market ratios; common-size
and trend analysis; DuPont; earnings quality; sustainable growth) and on cost
management (cost behaviour, CVP, operating/financial leverage); IAS 21 (foreign
exchange); Altman (Z''-score for private and non-manufacturing firms). The product
never names any exam or curriculum — it speaks the language of analysis.

---

## Part 1 — Multi-currency (IAS 21, simplified for SMEs)

### Rules we implement

| Rule | IAS 21 basis | Mizan behaviour |
|---|---|---|
| Functional currency = the company's base currency | §8–14 | Chosen at setup, never changes |
| A foreign transaction is recorded at the spot rate on its date | §21–22 | Invoice / bill / payment carry `currency` + `exchange_rate`; the rate comes from the rate table (latest on or before the date) and can be overridden per document |
| Monetary items are re-measured at the closing rate at each reporting date | §23(a) | **Revaluation run** (any date): open foreign invoices/bills and foreign cash/bank balances; posted to revaluation accounts and **reversed the next day** |
| Non-monetary items stay at historical rate | §23(b) | Inventory, fixed assets, expenses are converted once and never revalued |
| Exchange differences on settlement go to profit or loss | §28 | **Realised** gain/loss line inside the payment's journal entry |
| Unsettled differences at period end go to profit or loss | §28 | **Unrealised** gain/loss from the revaluation run |

### Design decisions
- Rates stored as integers × 1,000,000 (base currency per 1 foreign unit) — no floats.
- Every document line keeps its foreign amounts (what is printed) **and** base amounts
  (`base_net`, `base_tax`) computed once; everything that values stock, tax returns,
  ageing and reports reads **base** amounts. The journal is built from base amounts, so it
  always balances exactly (no rounding plug).
- Journal lines carry `currency` and `amount_fx` (signed foreign amount) so foreign bank
  balances and party balances in currency can be read straight from the ledger.
- Settlements store both the document-currency amount and the base amount. The **last**
  settlement of a document takes the exact remaining base value (no stray cents).
- A payment and the documents it settles must share a currency. The payment entry
  credits the receivable at each invoice's historical base value; the difference to the
  cash received is the realised FX gain/loss.
- A credit note against a foreign invoice uses the invoice's rate (a return reverses the
  original sale); any rounding cent is booked as FX difference.
- A foreign-currency bank/cash account (account `currency`) only takes payments in that
  currency; a base-currency account may receive foreign payments (the bank converts).
- Unrealised revaluation of receivables/payables goes to separate adjustment accounts
  (asset / liability) so ageing and party statements stay in historical values while the
  balance sheet shows closing-rate values; foreign cash is revalued in the bank account
  itself. Both reverse on the next day, so nothing accumulates.

### Edge cases handled
| Case | Handling |
|---|---|
| No rate for the date | Uses the latest earlier rate; if none exists: error `fx.no_rate` asking for one |
| Rate entered as "1 USD = 48.35 EGP" vs inverse | Always "base per 1 foreign unit"; the form shows the inverse as a check |
| Rounding on many lines | Each line converted once; totals are sums of converted lines; journal balances by construction |
| Partial payments at different rates | Each allocation settles at the invoice's rate; the last one takes the remainder |
| Over-payment / on-account foreign money | Unallocated part booked at the payment rate on the party account |
| Payment in USD into an EGP bank account | Allowed; cash line in base only |
| Credit note in another currency than the invoice | Refused (`fx.currency_mismatch`) |
| Revaluation run twice for the same date | Refused (`fx.already_revalued`) — reverse the earlier run first |
| Voiding a foreign payment after revaluation | Works: the reversal restores historical values; revaluation had already reversed |
| Currency switched off with open foreign documents | Blocked (`fx.in_use`) |
| Goods receipt / purchase order linked to a foreign bill | Stock is valued at base amounts; receipt vs bill difference already handled by inventory's price variance |
| Company base currency used as "foreign" | Refused — the base currency has no rate |
| Currencies with 0 or 3 decimals | Stored at the company's money precision (documented limitation; a KWD company should use 3 decimals as base precision) |

---

## Part 2 — Financial statements (core, in the General ledger)

Already: trial balance, general ledger, multi-step income statement, classified balance
sheet, indirect cash-flow statement.

Added:
1. **Income statement, analytical form** — revenue, COGS, **gross profit**, operating
   expenses, **operating profit (EBIT before other items)**, other income/expense,
   **interest expense**, **profit before tax**, **income tax**, **net profit**, plus
   **EBITDA** (depreciation separated). New account subtypes: `interest_expense`,
   `income_tax`, `short_term_debt`, `marketable_securities`, `dividends`.
2. **Statement of changes in equity** — opening, profit, contributions, dividends /
   drawings, other movements, closing, per equity account.
3. **Common-size (vertical) analysis** — every income line as % of revenue; every balance
   sheet line as % of total assets.
4. **Comparative (horizontal) analysis** — two periods side by side with change and change %.
5. **Multi-period trend** — up to 12 months/quarters/years for the key figures.

Statements are table stakes: every company needs them, so they stay in the core.

---

## Part 3 — The analysis engine (separate app: *Financial analysis*)

### 3.1 Ratio catalogue (formula · meaning · direction)

**Liquidity**
| Ratio | Formula | Good when |
|---|---|---|
| Working capital | CA − CL | positive, stable |
| Current ratio | CA ÷ CL | 1.5–2 typical; too high = idle assets |
| Quick (acid-test) | (Cash + marketable securities + receivables) ÷ CL | ≥ 1 |
| Cash ratio | (Cash + marketable securities) ÷ CL | 0.2–0.5 |
| Operating cash-flow ratio | CFO ÷ CL | ≥ 1 |
| Defensive interval (days) | Quick assets ÷ daily cash operating expenses | longer is safer |

**Solvency / leverage**
| Ratio | Formula |
|---|---|
| Debt ratio | Total liabilities ÷ total assets |
| Debt-to-equity | Total liabilities ÷ equity |
| Long-term debt-to-equity | Non-current liabilities ÷ equity |
| Debt-to-capital | Interest-bearing debt ÷ (interest-bearing debt + equity) |
| Equity multiplier (financial leverage) | Average total assets ÷ average equity |
| Times interest earned | EBIT ÷ interest expense |
| Fixed-charge coverage | (EBIT + lease/rent) ÷ (interest + lease/rent) |
| Cash-flow to debt | CFO ÷ total liabilities |

**Activity / efficiency** (averages of opening and closing balances; days = days in the period)
| Ratio | Formula |
|---|---|
| Receivables turnover | Revenue ÷ average receivables |
| Days sales outstanding (DSO) | Average receivables ÷ revenue × days |
| Inventory turnover | COGS ÷ average inventory |
| Days inventory outstanding (DIO) | Average inventory ÷ COGS × days |
| Payables turnover | Purchases (COGS + Δ inventory) ÷ average payables |
| Days payables outstanding (DPO) | Average payables ÷ purchases × days |
| Operating cycle | DIO + DSO |
| Cash conversion cycle | DIO + DSO − DPO |
| Total asset turnover | Revenue ÷ average total assets |
| Fixed asset turnover | Revenue ÷ average net fixed assets |
| Working-capital turnover | Revenue ÷ average working capital |

**Profitability**
| Ratio | Formula |
|---|---|
| Gross margin | Gross profit ÷ revenue |
| Operating margin | Operating profit ÷ revenue |
| EBITDA margin | EBITDA ÷ revenue |
| Net margin | Net profit ÷ revenue |
| Return on assets (ROA) | Net profit ÷ average total assets |
| Return on equity (ROE) | Net profit ÷ average equity |
| Return on invested capital | EBIT × (1 − tax rate) ÷ average (debt + equity) |
| DuPont (3 parts) | Net margin × asset turnover × equity multiplier = ROE |
| DuPont (5 parts) | Tax burden (NI/EBT) × interest burden (EBT/EBIT) × EBIT margin × asset turnover × equity multiplier |

**Cash-flow quality & growth**
| Measure | Formula |
|---|---|
| Earnings quality | CFO ÷ net profit (> 1 = profits turn into cash) |
| Free cash flow | CFO − capital expenditure |
| Accruals ratio | (Net profit − CFO) ÷ average total assets |
| Payout ratio | Dividends ÷ net profit |
| Retention ratio | 1 − payout |
| Sustainable growth rate | ROE × retention |
| Revenue / profit growth | vs comparison period |

**Market (only when share data is entered)**
EPS = (net profit − preferred dividends) ÷ weighted shares; P/E = price ÷ EPS; book value
per share = common equity ÷ shares; price-to-book; dividend yield = dividend per share ÷
price; earnings yield = EPS ÷ price.

**Leverage & break-even (cost behaviour)**
Every expense account gets a *variable share* (COGS 100 %, operating expenses 0 % by
default, editable — mixed costs supported).
| Measure | Formula |
|---|---|
| Contribution margin | Revenue − variable costs |
| Contribution margin ratio | CM ÷ revenue |
| Break-even revenue | Fixed costs ÷ CM ratio |
| Margin of safety | (Revenue − break-even) ÷ revenue |
| Degree of operating leverage | CM ÷ operating profit (= 1 ÷ margin of safety) |
| Degree of financial leverage | EBIT ÷ EBT |
| Degree of total leverage | DOL × DFL |
| Target-profit revenue | (Fixed costs + target profit) ÷ CM ratio |

**Distress score** — Altman Z'' (private, non-manufacturing, 1995):
Z'' = 6.56·(WC/TA) + 3.26·(RE/TA) + 6.72·(EBIT/TA) + 1.05·(Equity/TL);
safe > 2.6, grey 1.1–2.6, distress < 1.1.

### 3.2 Edge cases (each ratio returns a value **or** a reason)
| Situation | Result |
|---|---|
| Denominator zero (no interest, no inventory, no revenue) | "not applicable" with the reason (e.g. *no borrowing costs — nothing to cover*) instead of ∞ / NaN |
| Negative equity | ROE, D/E, equity multiplier marked **not meaningful**; a solvency warning is raised |
| Loss for the period | P/E not meaningful; DOL/DFL shown but flagged (below break-even) |
| Operating profit ≤ 0 | DOL/margin of safety flagged "below break-even" |
| Contribution margin ≤ 0 | break-even "cannot be reached at the current cost structure" |
| Period shorter than a year | turnovers and returns shown for the period **and annualised** (× 365 ÷ days) |
| First period (no opening balances) | averages fall back to closing balances, flagged |
| Service company (no inventory) | inventory ratios hidden, CCC = DSO − DPO |
| Very small base (< 1 % of revenue) | growth % suppressed as noisy |
| Accounts mis-classified (e.g. a loan in current liabilities) | a data-quality check lists missing subtypes (no interest account, no tax account, no depreciation) so ratios are not silently wrong |
| Exchange revaluation entries | kept in profit (they are real P&L under IAS 21), shown under other income / expense |
| Closing entries | excluded from P&L figures (as in the income statement) |

### 3.3 From numbers to advice
Each ratio has thresholds (healthy / watch / risk) and a sentence written for a
non-accountant, e.g. *"Customers take 74 days to pay while you pay suppliers in 31 —
you are financing your customers for 43 days."* The summary page ranks the 3–5 most
important findings and shows the trend versus the comparison period.

---

## Part 4 — Built in or sold separately?

**Decision: statements in the core; the analysis engine as a separate app, sold as an add-on.**

Reasons:
1. **Statements are obligations, analysis is advice.** Every company must produce
   statements (law, tax, banks). Taking them away would make the base product unusable
   and look mean. Analysis is what a company would otherwise pay a consultant or a senior
   accountant for — that is the value to charge for.
2. **Clear value, clear price.** "Your accountant's analysis, every month, automatically"
   is easy to understand and easy to justify next to the cost of one advisory hour.
3. **Mechano rule.** The engine reads the ledger only; it posts nothing. As its own
   module it can be improved, tested and released on its own without risk to the books,
   and removed from an edition with no side effects.
4. **Right audience.** Micro businesses on the basic edition may not want 40 ratios;
   growing companies, their banks and investors do — they buy the upgrade.
5. **Upsell path.** The Apps page presents it with its benefits; a trial is simply switching
   it on, and switching it off loses nothing (it stores no data of its own besides share data).

Pricing guidance (for the business, not in code): include it in the "Trade" and "Full"
editions, offer it as an add-on to "Finance".

---

## Part 5 — Delivery plan
1. **FX module** (`fx`, app *Multi-currency*): currencies, rates, document & payment
   currency, realised & unrealised differences, revaluation run, currency columns in lists.
2. **Ledger additions**: new subtypes, analytical income statement, changes in equity,
   common-size & comparative views.
3. **Analysis module** (`analysis`, app *Financial analysis*): ratio engine with reasons,
   DuPont, cash-conversion cycle, leverage & break-even, Z'', data-quality checks, advice,
   trends; cost-behaviour settings per expense account; share data settings.
4. Tests for every formula on a hand-worked company, and for each edge case.
