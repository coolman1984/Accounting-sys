# Demo company — Horizon Electronics, an invented electronics factory

`npm run demo` (or `start-demo.bat`) builds a company in `data-demo/` from
`apps/server/src/demo/horizon-electronics.ts`, through the app's own HTTP API, so every figure comes from
the real engine. `src/test/demo.test.ts` builds the same company in memory and checks that it ties.

**The company is invented. Only the general Egyptian facts below are real. Every amount, quantity, price,
person, customer and supplier is illustrative** — realistic in size, not company records.

## General facts used

| Fact | Source |
|---|---|
| Private-sector minimum wage 7,000 EGP (from March 2025) | [SIS](https://sis.gov.eg/en/media-center/news/egypt-raises-minimum-wage-for-private-sector-to-egp-7-000/) |
| Industrial medium-voltage electricity 1.94 EGP/kWh after the April 2026 rise | [EgyptERA](https://egyptera.org/en/TarrifApril2026.aspx), [Mada Masr](https://www.madamasr.com/en/2026/05/21/news/u/govt-releases-new-electricity-tariffs-revealing-hikes-that-extend-to-egypts-major-power-users/) |
| USD/EGP around 50–54 during 2026 (51.8 late September) | [Investing.com](https://www.investing.com/currencies/usd-egp-historical-data) |

## What the demo contains (1 January – 25 September 2026)

- **Opening balance sheet** on 1 January (entry marked *opening*, cleared through 3900): land, buildings
  and production lines at historical EGP cost with depreciation already charged, cash, a 1.2 bn loan at
  21%, capital 2.5 bn, retained earnings as the balancing figure, stock counted on 31 December.
- **Manufacturing**: 5 products (TV 43/55/65", phone P16, Tab T9) with standard recipes (labour 95,
  variable overhead 60, fixed overhead 250 EGP an hour); two production orders per product a month
  with small actual usage and hour differences, so the variance report has real numbers.
- **Imports** from HQ in USD (90 days), customs 2% capitalised as a landed cost, import VAT 14% paid
  at the port (journal to 1150); dollars are bought from the EGP account only when HQ invoices fall due.
- **Sales**: exports in USD, zero-rated (tax code VAT0-EXP), shipped via an Alexandria staging
  warehouse to 5 group sales companies (invented); local distributors with 14% VAT, 1% withholding by customers,
  two of them paying by post-dated cheques; government tablet programme at a tender price; a credit
  note for transport damage; a World Cup promotion in May–June.
- **Overheads** on 8 cost centers: electricity (tariff change in April), contract labour (3% withholding),
  security, maintenance, logistics, export clearing, marketing, telecom, office rent (recurring template).
- **Payroll**: 135 employees, Egyptian salary tax (Law 7/2024) and social insurance, two joiners
  pro-rated; paid monthly from a separate payroll bank account.
- **Month end**: depreciation runs, FX revaluation, VAT / insurance / salary tax / Form 41 payments,
  quarterly income-tax provision (22.5%), loan interest and instalments. September is still open.
- An approved **budget** for 2026, and the **September CIB statement** reconciled.

## Things an accountant will notice (on purpose, or limits of the app)

- The advisor warns about **payments to the electricity company and the landlord without withholding**.
  Whether they are in scope of the withholding rules is a question for the tax adviser; the demo leaves
  them untyped so the warning can be shown.
- **Import VAT** is booked by journal (from the customs release), so the VAT summary report — which reads
  invoices and bills — shows local VAT only; account 1150 holds both. The company carries a VAT credit
  (an exporter), which is realistic. The advisor's monthly VAT tip is also document-based.
- The **material price variance** (about −3%) comes from standards set at the January rate while
  actual cost includes customs and the dollar's movement.
- Cheques deposited on 25 September clear after the demo date, so they show as "overdue" in the portfolio.
