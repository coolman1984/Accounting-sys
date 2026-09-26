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
    src/kernel/           the "chassis": db, modules, services, events, money, dates
    src/modules/          the "parts": system, ledger, parties, catalog,
                          documents, payments, inventory, reports
    src/test/             end-to-end accounting tests
  web/                    React 19 + Vite + TanStack Query + React Router
    src/core/             i18n (en/ar), theme, session, API client, formatting
    src/ui/               design-system components
    src/shell/            sidebar, top bar, ⌘K command palette
    src/modules/          one folder per feature, mirroring the server
docs/                     this document and the roadmap
```

## 2. The "mechano" principle — every feature is a module

### Server

Each feature implements one small contract (`kernel/modules.ts`):

```ts
interface AppModule {
  id: string;                 // also the migration namespace
  dependsOn?: string[];       // kernel orders modules by dependency
  migrations?: Migration[];   // owns its tables, applied once, never edited
  permissions?: string[];     // e.g. 'sales.post'
  setup?(ctx): void;          // provide a typed service, subscribe to events
  routes?(router, ctx): void; // mount HTTP endpoints under /api
}
```

Modules connect through three well-defined sockets — never by reaching into
each other's tables for writes:

| Socket | What it is | Example |
|---|---|---|
| **Services** | typed public API, `services.get('ledger')` | documents call `ledger.createEntry()` to post |
| **Events** | synchronous, inside the same DB transaction | `system.setup` → ledger seeds the chart, catalog seeds VAT |
| **Permissions** | declared per module, resolved per role | `payments.post`, `reports.read` |

Adding a feature (inventory, payroll, fixed assets…) = write a module, add it
to `modules/index.ts`. The kernel does not change.

### Web

The front end mirrors this. A `WebModule` contributes navigation items, pages
and command-palette actions; the shell composes whatever is installed
(`web/src/core/registry.ts`, `web/src/modules/index.ts`).

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

Known limits (see roadmap): stock checks use the current balance (not the
balance at a back-dated date), one unit of measure per item, no batches /
expiry / serial numbers yet.

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

## 6. Security & multi-user

* Users with roles: **Administrator**, **Accountant**, **Viewer** (read-only).
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
* Printable invoices and reports; CSV export (Excel-friendly UTF-8 BOM).
* Responsive down to phones (slide-in navigation).
