# Mizan — Architecture

Mizan (ميزان, "balance") is a **local-first, double-entry accounting system**.
One computer runs the server; every other PC on the office network uses it
from a browser. No cloud, no subscription, one SQLite file holds the books.

```
 ┌──────────── Office LAN ─────────────┐
 │  PC 1 (browser) ─┐                   │
 │  PC 2 (browser) ─┼──► Mizan server ──┼──► data/mizan.db  (+ daily backups)
 │  PC 3 (browser) ─┘    Node + Fastify │
 └──────────────────────────────────────┘
```

## 1. Repository layout

```
apps/
  server/                 Node 22 + Fastify + SQLite (node:sqlite) + zod
    src/kernel/           the "chassis": db, modules, services, events, apps, money, dates
    src/contracts/        shared types modules use to talk to each other
    src/modules/          the "parts": system + ledger (GL core), ar, ap, payments
                          (treasury), tax, co, inventory, purchasing, pricing, and the
                          engines parties, catalog, documents
    src/test/             end-to-end tests + boundary, edition and docs checks
  web/                    React 19 + Vite + TanStack Query + React Router
    src/core/             i18n (en/ar), theme, session, API client, formatting
    src/ui/               design-system components shared by every module
    src/engines/          shared screens used by several apps (documents, parties)
    src/shell/            sidebar, top bar, ⌘K command palette
    src/modules/          one folder per app: gl, ar, ap, treasury, tax, co,
                          inventory, purchasing, pricing, catalog, dashboard, admin, auth
scripts/                  edition.mjs (build an edition), docs-map.mjs (program map)
docs/                     see docs/README.md — MAP.md tells where everything lives
```

## 2. The "mechano" principle — every feature is a module

### Server

Each feature implements one small contract (`kernel/modules.ts`):

```ts
interface AppModule {
  id: string;                 // also the migration namespace
  dependsOn?: string[];       // kernel orders modules by dependency
  migrations?: Migration[];   // owns its tables, applied once, never edited
  permissions?: string[];     // 'module.object.action', e.g. 'ar.invoices.post'
  roles?: RoleTemplate[];     // ready-made roles offered in Users & roles
  sod?: [string, string][];   // duties better held by two different people
  setup?(ctx): void;          // provide a typed service, subscribe to events
  routes?(router, ctx): void; // mount HTTP endpoints under /api
  apps?: AppManifest[];       // the switchable apps this module provides
  health?(ctx): HealthCheck[];// self-checks of the module's own data
}
```

Modules connect through three well-defined sockets — never by reaching into
each other's tables for writes:

| Socket | What it is | Example |
|---|---|---|
| **Services** | typed public API, `services.get('ledger')` | documents call `ledger.createEntry()` to post |
| **Events** | synchronous, inside the same DB transaction | `system.setup` → ledger seeds the chart, catalog seeds VAT |
| **Permissions** | declared per module, resolved per role | `treasury.payments.post`, `gl.reports.read` |
| **Registries** | an engine lets apps plug in | AR registers `sales_invoice` with `documents.registerKind`, `customer` with `parties.registerRole` |

Shared types live in `src/contracts/`. A test (`test/boundaries.test.ts`) fails
if a module imports another module's code directly — on the server and in the
web app — so every piece stays removable.

Adding a feature (inventory, payroll, fixed assets…) = write a module, add it
to `modules/index.ts`. The kernel does not change.

### Apps — sell only what a customer needs

Modules are how the code is built; **apps** are what a company switches on
(`kernel/apps.ts`, the Apps page, and a step in the setup wizard):

| App | Modules | Unlocks | Needs |
|---|---|---|---|
| General ledger (core, always on) | system, ledger | accounts, journal, fiscal years, statements, users & roles, settings | — |
| Receivables (AR) | ar (+ parties, catalog, documents) | customers, sales invoices, credit notes, ageing | — |
| Payables (AP) | ap (+ engines) | suppliers, bills, debit notes, ageing | — |
| Treasury | payments, bank | receipts and payments (separate rights), transfers, bank reconciliation | — |
| Tax | tax | tax codes, tax on lines, tax summary | — |
| Cost centers (CO) | co | cost centers on lines, P&L per center | — |
| Inventory | inventory | warehouses, lots, receipts, landed costs | — |
| Purchase orders | purchasing | orders, approval, receive & bill from the order | AP |
| Price lists | pricing | price lists, minimum price guard | AR |
| Multi-currency | fx | currencies, rates, foreign documents and payments, revaluation | — |
| Financial analysis | analysis | ratios, notes, break-even, trend (read-only) | — |

### Editions — deliver only what was bought

`npm run edition -- finance --check` (or a list such as `gl,ap,purchasing`)
copies the program without the other apps' folders, rewrites the server and
web module lists from `dependsOn`, and runs typecheck plus the edition tests on
the copy. Presets: `ledger`, `finance`, `trade`, `full` (`--list` shows them).

A module declares the apps it provides; one module can serve several
(documents → Sales and Purchases) and several modules can add to one app.
Switching an app off removes its permissions from every user on the next
request (no restart), its listeners go to sleep (without Inventory, products
are bought as expenses and sold without stock checks), and its data stays for
when it is switched back on. Voids always run, so turning an app off never
leaves stock or balances half-undone.

### Health checks — find faults by module

Every module checks its own figures (`health()`): the ledger balances, every
posted document has its entry, payments are not over-applied, stock value
equals the inventory accounts, lots add up to warehouses, GRNI equals its
account, order progress stays within the orders, the database file is intact,
a recent backup exists. `/api/system/health` runs each module separately — one
failing check never hides the others — and the **System health** page shows the
result per module, so a problem points straight at the part that has it.

### Web

The front end mirrors this. A `WebModule` contributes navigation items, pages
and command-palette actions; the shell composes whatever is installed
(`web/src/core/registry.ts`, `web/src/modules/index.ts`). Menu items, commands
and report tiles carry the app they belong to (`app: 'inventory'`), so the
menus follow the Apps page.

## 3. Accounting core — rules that can never be broken

| Rule | Where it is enforced |
|---|---|
| Money is never a float: integers in minor units (piasters/cents); quantities ×1000; rates in basis points | `kernel/money.ts` (BigInt math, round half away from zero), mirrored in the web preview |
| Every entry balances (Σ debit = Σ credit, ≥ 2 lines, total > 0) | service validation **and** a SQLite trigger at posting |
| A line is either debit or credit, never both, never negative | `CHECK` constraint |
| Posted entries are immutable; corrections are reversals | triggers block UPDATE/DELETE on posted entries and their lines |
| Group (header) accounts never receive postings | trigger + validation |
| Receivable / payable lines always carry a customer/supplier | validation (keeps sub-ledgers reconcilable) |
| Posting dates must be in an open fiscal year and after the lock date | `ledger.assertPostingDate` |
| Numbers are gap-free and never reused (JE-, INV-, RCT- …) | sequences table, assigned at posting |
| Posted documents and payments are frozen | triggers |
| The audit trail is append-only | triggers |

Every business document **produces** a journal entry through the ledger
service; reports read only the ledger (`ledger` view of posted lines). So the
trial balance, statements, party balances and aging always agree.

### Posting map

| Document | Debit | Credit |
|---|---|---|
| Sales invoice | Accounts receivable (party) — total | Revenue per line (net), Output VAT |
| Customer credit note | Revenue, Output VAT | Accounts receivable (party) |
| Purchase bill | Expense / asset per line, Input VAT | Accounts payable (party) |
| Supplier debit note | Accounts payable (party) | Expense / asset, Input VAT |
| Receipt from customer | Cash / bank | Accounts receivable (party) |
| Payment to supplier | Accounts payable (party) | Cash / bank |
| Direct receipt / payment | Cash / bank ↔ chosen income / expense account | |
| Transfer between cash / bank | Receiving account (amount); Bank charges (fee) | Sending account (amount + fee) |
| Bank line recorded from a statement | Bank ↔ chosen income / expense account | |
| Year-end close | Revenue accounts | Expense accounts; net → Retained earnings |
| Purchase of a stock item | Inventory (instead of an expense) | — as a normal bill |
| Sale of a stock item (automatic, separate "cost of goods" entry) | Cost of goods sold | Inventory — at average cost |
| Stock adjustment / count / opening stock | Inventory ↔ Inventory adjustments (Capital for opening) | |

Voiding a document or payment posts a **reversal** and releases its
settlements; nothing is ever deleted once posted.

### Settlements

Invoices/bills track `amount_settled`. A payment's allocations and a credit
note linked to an invoice create `settlements` rows. Money in settles
invoices and supplier debit notes; money out settles bills and customer credit
notes. Unallocated money stays "on account" in the party's ledger balance and
shows as a separate column in aging, so aging always reconciles to the ledger.

## 4. Inventory

The inventory module is a separate part that plugs into sales & purchases
through events — the documents module does not know it exists.

* **Warehouses** hold quantities (`stock_levels`, per item × warehouse, with a
  `CHECK (qty >= 0)`: stock can never go negative).
* **Costing: moving weighted average**, pooled per item across warehouses
  (`stock_values`), so transfers never change cost. Incoming moves carry their
  value; outgoing moves take `value × qty ÷ pooled qty`; the last unit out takes
  the whole remaining value, so rounding never leaves ghost value behind.
* **Stock ledger** (`stock_moves`): immutable, every move stores the running
  item and warehouse balances → the item card (كارت الصنف) is instant.
* **Automatic postings:** when an invoice/bill/credit note is posted or voided,
  inventory moves the goods *inside the same transaction* and posts one "cost of
  goods" entry for the difference between the stock value change and what the
  document already booked to inventory. This single rule covers sales (COGS),
  customer returns (back at their original cost), supplier returns (price
  difference to cost of sales) and voids — and guarantees
  **inventory accounts = stock valuation, always**.
* **Stock documents:** adjustments (±, at a cost or at average), opening stock,
  physical counts (enter what you counted, only differences post), transfers.
* **Reports:** stock on hand (by warehouse / category / status), item card,
  valuation at any date **reconciled to the ledger**, movement summary
  (opening / in / out / closing), reorder suggestions with 90-day sales, item
  profitability (revenue − COGS, margin).
* **Web:** live "available" hints and shortage warnings while typing an
  invoice, barcode-ready item search, stock panel on every document, dashboard
  widget, report tiles — all contributed through the web module slots.

Next level (Phase 2b): units of measure with conversions, lots with expiry
(first to expire goes first, expired lots are never sold), serial numbers,
goods receipts with a GRNI account, landed costs split by value or quantity,
back-dated postings that re-cost later sales automatically, purchase orders
and price lists with a minimum price guard.

### Bank reconciliation

A statement (per cash/bank account and date) holds the bank's lines: + money in,
− money out. Each line is ticked against exactly one posted ledger line of that
account (`bank_statement_lines.journal_line_id`, unique) — the ledger itself is
never changed. Automatic matching pairs equal amounts within ten days, preferring
the same reference. Lines the books do not have yet (charges, interest) are
posted in one step. A statement can be finished only when every line is matched
and opening + lines = closing; the next statement must start from that closing
balance. Reconciled statements are locked by triggers, and the `journal.reversed`
listener refuses to reverse an entry they contain. An entry that was reversed
(a voided payment or transfer) cancels out with its reversal and is left out of
the "not yet at the bank" list.

### Multi-currency

Documents and payments keep their currency and rate; each line stores base
figures (`base_net`, `base_tax`) computed once, and everything that values the
books reads base figures. Journal lines on foreign items carry `currency` and
`amount_fx`. Payments credit receivables at each invoice's historical value
(the last one clears the exact remainder) and book the realised difference.
The revaluation run re-measures open foreign items and foreign cash at a date,
posts to adjustment accounts and reverses on the next day. See ADR-011.

## 5. Reports

All reports are computed from posted ledger movements:

* **Trial balance** — opening / movement / closing per account.
* **General ledger** — lines with running balance (group accounts include sub-accounts).
* **Income statement** — revenue, cost of sales, gross profit, operating
  expenses, operating profit, other items, net profit; comparison period;
  excludes closing entries so closed years still show their result.
* **Balance sheet** — current / non-current assets & liabilities, equity plus
  profit not yet closed; comparison date; self-check `balanced`.
* **Cash flow (indirect)** — net profit + non-cash items + working capital,
  investing, financing; self-check `reconciled` against cash accounts.
* **Aging** — receivables / payables by days overdue, reconciled to the ledger.
* **VAT summary** — output vs input tax from posted documents.
* **Dashboard** — cash, AR, AP, monthly P&L series, overdue, top debtors.
* **Changes in equity** — capital, retained earnings, dividends and unclosed
  profit, reconciled to the balance sheet; **common-size** views of the income
  statement (% of revenue) and balance sheet (% of total assets).
* **Financial analysis app** — `modules/analysis/engine.ts` (pure) turns a
  period snapshot into 50 ratios with status, reasons and previous values,
  DuPont, Z'' score and plain-language findings; `/analysis/break-even` runs
  what-if scenarios; `/analysis/trend` gives 12 months. Statements are shared
  from `modules/ledger/statements.ts`.

## 6. Security & multi-user

* **Users & roles** (Admin › Users & roles), simplified from SAP role
  collections and Business Central permission sets:
  * rights are `module.object.action` (view, create & edit, post, approve, manage, override),
    shown as a matrix per module;
  * built-in roles **Administrator**, **Accountant**, **Viewer**; custom roles from
    templates each module offers (sales clerk, cashier, storekeeper, controller …);
  * a user may hold several roles; rights add up, limited to the apps that are on,
    and apply on the next request (no re-login);
  * separation-of-duties pairs (e.g. create suppliers × pay suppliers) show a warning;
  * users, settings, backups and price override are administrator-only; the last
    active administrator cannot be removed.
* Passwords hashed with scrypt; sessions are random tokens stored as SHA-256,
  HttpOnly cookie; brute-force cool-down on login.
* Every write is audited (who, what, when, before/after).
* SQLite in WAL mode; all writes run in synchronous, serialised transactions,
  so two PCs posting at the same moment can never interleave.
* Daily automatic backups (last 14 kept) + on-demand backup & download.

## 7. UI / UX

* Design language taken from the reference: white canvas, hairline borders,
  blue primary pill buttons, soft elevated cards, colourful "graph line"
  accents, sun/moon theme pill, ⌘K / Ctrl+K command palette.
* **Light & dark** themes (tokens in `web/src/styles/tokens.css`), follows the
  OS by default.
* **English & Arabic** with full RTL (logical CSS properties everywhere;
  bilingual account and item names; Latin digits for accounting clarity,
  Arabic-Indic digits accepted on input).
* Keyboard-first data entry: searchable pickers, Ctrl+S save draft,
  Ctrl+Enter post, live balance bar in the journal editor, live totals in
  documents.
* **Excel-like lists** (`web/src/ui/DataGrid.tsx`): every column sorts and
  filters on its own (value lists with counts, ranges, dates), quick filters,
  group by any column with subtotals, show/hide columns, saved favourite views
  and CSV export of exactly what is shown — the same grid on every list.
* **Menus on the side or across the top** (Odoo-style dropdowns), switched
  with one click and remembered per computer. Menus are grouped by professional
  module like SAP — GL, AR, AP, TR, TX, CO, MM, IM — with the module code beside
  each title (`SECTION_ORDER` / `SECTION_CODE` in `web/src/core/registry.ts`);
  side sections fold and remember it.
* Printable invoices and reports; CSV export (Excel-friendly UTF-8 BOM).
* Responsive down to phones (slide-in navigation).
