# Program map

> **Generated from the code by `npm run docs:map` — do not edit by hand.**
> A test fails when this file is out of date, so it always matches the code.

Where to find things: pick the module, then the file. Modules talk only through
`kernel/`, `contracts/`, services and events (see [ARCHITECTURE](ARCHITECTURE.md)).

## Apps → modules

| App | Server modules | Needs | Permission prefixes |
|---|---|---|---|
| **gl** (core) | `system`, `ledger` | — | `admin`, `gl` |
| **treasury** | `payments` | — | `treasury` |
| **inventory** | `inventory` | — | `inventory`, `catalog` |
| **purchasing** | `purchasing` | `ap` | `purchasing` |
| **pricing** | `pricing` | `ar` | `pricing` |
| **tax** | `tax` | — | `tax` |
| **ar** | `ar` | — | `ar`, `catalog` |
| **ap** | `ap` | — | `ap`, `catalog` |
| **co** | `co` | — | `co` |

Engines (no app of their own, pulled in by `dependsOn`): `parties`, `catalog`, `documents`

## Server layout

| Folder | Files | What lives there |
|---|---|---|
| `apps/server/src/kernel/` | 11 | the chassis: db adapter, module loader, services, events, apps, money, dates, validation |
| `apps/server/src/contracts/` | 6 | shared types and constants modules use to talk to each other |
| `apps/server/src/modules/` | 26 | one folder per module (below) |
| `apps/server/src/test/` | 9 | end-to-end tests, boundary and edition tests |

Contracts: `catalog.ts`, `co.ts`, `documents.ts`, `inventory.ts`, `parties.ts`, `tax.ts`

## Server modules (in load order)

### `system` — apps/server/src/modules/system/

- **Apps:** `gl` · **Depends on:** — · **Health checks:** yes
- **Permissions:** `admin.settings.read`, `admin.settings.manage`, `admin.users.manage`, `admin.audit.read`, `admin.backup.manage`
- **Tables / views:** `audit_log`, `role_permissions`, `roles`, `sequences`, `sessions`, `settings`, `user_roles`, `users`
- **Provides services:** `access`, `audit`, `backup`, `sequences`, `settings`
- **Events:** emits `system.setup` · listens —
- **Files:** `auth.ts` (182), `index.ts` (490), `schema.ts` (95), `settings.ts` (116)

<details><summary>25 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/system/info` | `public` |
| POST | `/api/setup` | `public` |
| POST | `/api/auth/login` | `public` |
| POST | `/api/auth/logout` | `auth` |
| GET | `/api/auth/me` | `auth` |
| PUT | `/api/auth/me` | `auth` |
| POST | `/api/auth/password` | `auth` |
| GET | `/api/users` | `admin.users.manage` |
| POST | `/api/users` | `admin.users.manage` |
| PUT | `/api/users/:id` | `admin.users.manage` |
| GET | `/api/roles` | `admin.users.manage` |
| GET | `/api/permissions` | `admin.users.manage` |
| POST | `/api/roles` | `admin.users.manage` |
| PUT | `/api/roles/:id` | `admin.users.manage` |
| DELETE | `/api/roles/:id` | `admin.users.manage` |
| POST | `/api/users/:id/password` | `admin.users.manage` |
| GET | `/api/settings` | `auth` |
| PUT | `/api/settings/company` | `admin.settings.manage` |
| PUT | `/api/settings/lock-date` | `admin.settings.manage` |
| GET | `/api/sequences` | `admin.settings.read` |
| PUT | `/api/sequences/:key` | `admin.settings.manage` |
| GET | `/api/audit` | `admin.audit.read` |
| GET | `/api/system/backups` | `admin.backup.manage` |
| POST | `/api/system/backups` | `admin.backup.manage` |
| GET | `/api/system/backups/:name` | `admin.backup.manage` |

</details>

### `ledger` — apps/server/src/modules/ledger/

- **Apps:** `gl` · **Depends on:** `system` · **Health checks:** yes
- **Permissions:** `gl.accounts.read`, `gl.accounts.write`, `gl.journal.read`, `gl.journal.write`, `gl.journal.post`, `gl.fiscal.manage`, `gl.reports.read`
- **Role templates:** `bookkeeper`
- **Tables / views:** `accounts`, `fiscal_years`, `journal_entries`, `journal_lines`, `ledger`
- **Provides services:** `ledger`
- **Events:** emits `fiscalYear.closed`, `journal.posted`, `journal.reversed` · listens `system.setup`
- **Files:** `chart-template.ts` (146), `index.ts` (245), `reports.ts` (318), `schema.ts` (156), `service.ts` (643)

<details><summary>24 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/accounts/meta` | `gl.accounts.read` |
| GET | `/api/accounts` | `gl.accounts.read` |
| GET | `/api/accounts/:id` | `gl.accounts.read` |
| POST | `/api/accounts` | `gl.accounts.write` |
| PUT | `/api/accounts/:id` | `gl.accounts.write` |
| DELETE | `/api/accounts/:id` | `gl.accounts.write` |
| PUT | `/api/accounts-defaults` | `admin.settings.manage` |
| GET | `/api/fiscal-years` | `gl.journal.read` |
| POST | `/api/fiscal-years` | `gl.fiscal.manage` |
| POST | `/api/fiscal-years/:id/close` | `gl.fiscal.manage` |
| POST | `/api/fiscal-years/:id/reopen` | `gl.fiscal.manage` |
| GET | `/api/journal` | `gl.journal.read` |
| GET | `/api/journal/:id` | `gl.journal.read` |
| POST | `/api/journal` | `gl.journal.write` |
| PUT | `/api/journal/:id` | `gl.journal.write` |
| POST | `/api/journal/:id/post` | `gl.journal.post` |
| POST | `/api/journal/:id/reverse` | `gl.journal.post` |
| DELETE | `/api/journal/:id` | `gl.journal.write` |
| GET | `/api/reports/trial-balance` | `gl.reports.read` |
| GET | `/api/reports/general-ledger` | `gl.reports.read` |
| GET | `/api/reports/income-statement` | `gl.reports.read` |
| GET | `/api/reports/balance-sheet` | `gl.reports.read` |
| GET | `/api/reports/cash-flow` | `gl.reports.read` |
| GET | `/api/reports/dashboard` | `gl.reports.read` |

</details>

### `parties` — apps/server/src/modules/parties/

- **Apps:** — · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** —
- **Tables / views:** `parties`
- **Provides services:** `parties`
- **Events:** emits — · listens `system.setup`
- **Files:** `index.ts` (275)

<details><summary>6 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/parties` | `auth` |
| GET | `/api/parties/:id` | `auth` |
| POST | `/api/parties` | `auth` |
| PUT | `/api/parties/:id` | `auth` |
| DELETE | `/api/parties/:id` | `auth` |
| GET | `/api/parties/:id/statement` | `auth` |

</details>

### `catalog` — apps/server/src/modules/catalog/

- **Apps:** — · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `catalog.items.read`, `catalog.items.write`
- **Tables / views:** `item_categories`, `item_units`, `items`, `taxes`
- **Provides services:** `catalog`
- **Files:** `index.ts` (377)

<details><summary>9 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/items` | `catalog.items.read` |
| GET | `/api/items/lookup` | `catalog.items.read` |
| GET | `/api/item-categories` | `catalog.items.read` |
| POST | `/api/item-categories` | `catalog.items.write` |
| PUT | `/api/item-categories/:id` | `catalog.items.write` |
| DELETE | `/api/item-categories/:id` | `catalog.items.write` |
| POST | `/api/items` | `catalog.items.write` |
| PUT | `/api/items/:id` | `catalog.items.write` |
| DELETE | `/api/items/:id` | `catalog.items.write` |

</details>

### `documents` — apps/server/src/modules/documents/

- **Apps:** — · **Depends on:** `ledger`, `parties`, `catalog` · **Health checks:** yes
- **Permissions:** —
- **Tables / views:** `document_lines`, `documents`, `settlements`
- **Provides services:** `documents`
- **Events:** emits `document.posted`, `document.voided` · listens `system.setup`
- **Files:** `index.ts` (298), `schema.ts` (138), `service.ts` (413)

<details><summary>9 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/documents` | `auth` |
| GET | `/api/documents/:id` | `auth` |
| POST | `/api/documents` | `auth` |
| PUT | `/api/documents/:id` | `auth` |
| POST | `/api/documents/:id/post` | `auth` |
| POST | `/api/documents/:id/void` | `auth` |
| GET | `/api/reports/aging` | `auth` |
| GET | `/api/documents/overview` | `auth` |
| DELETE | `/api/documents/:id` | `auth` |

</details>

### `payments` — apps/server/src/modules/payments/

- **Apps:** `treasury` · **Depends on:** `ledger`, `parties`, `documents` · **Health checks:** yes
- **Permissions:** `treasury.receipts.read`, `treasury.receipts.write`, `treasury.receipts.post`, `treasury.payments.read`, `treasury.payments.write`, `treasury.payments.post`
- **Role templates:** `cashier`
- **Duties to split:** `ap.suppliers.write × treasury.payments.post`, `ar.customers.write × treasury.receipts.post`
- **Tables / views:** `payment_allocations`, `payments`
- **Provides services:** `payments`
- **Events:** emits `payment.posted`, `payment.voided` · listens `system.setup`
- **Files:** `index.ts` (476)

<details><summary>9 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payments/accounts` | `auth` |
| GET | `/api/payments/open-documents` | `auth` |
| GET | `/api/payments` | `auth` |
| GET | `/api/payments/:id` | `auth` |
| POST | `/api/payments` | `auth` |
| PUT | `/api/payments/:id` | `auth` |
| POST | `/api/payments/:id/post` | `auth` |
| POST | `/api/payments/:id/void` | `auth` |
| DELETE | `/api/payments/:id` | `auth` |

</details>

### `inventory` — apps/server/src/modules/inventory/

- **Apps:** `inventory` · **Depends on:** `ledger`, `catalog`, `documents` · **Health checks:** yes
- **Permissions:** `inventory.stock.read`, `inventory.operations.write`, `inventory.operations.post`, `inventory.receipts.read`, `inventory.receipts.write`, `inventory.receipts.post`, `inventory.landed.write`, `inventory.landed.post`, `inventory.warehouses.manage`
- **Role templates:** `storekeeper`, `inventory_controller`
- **Duties to split:** `inventory.operations.write × inventory.operations.post`
- **Tables / views:** `goods_receipt_lines`, `goods_receipts`, `landed_cost_allocations`, `landed_cost_targets`, `landed_costs`, `lot_levels`, `receipt_matches`, `stock_doc_lines`, `stock_docs`, `stock_levels`, `stock_lots`, `stock_moves`, `stock_moves_v2`, `stock_values`, `warehouses`
- **Provides services:** `inventory`
- **Events:** emits `stock.receipt.posted`, `stock.receipt.voided` · listens `document.posted`, `document.voided`
- **Files:** `engine.ts` (555), `index.ts` (865), `schema.ts` (308), `service.ts` (866)

<details><summary>39 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/inventory/warehouses` | `inventory.stock.read` |
| POST | `/api/inventory/warehouses` | `inventory.warehouses.manage` |
| PUT | `/api/inventory/warehouses/:id` | `inventory.warehouses.manage` |
| GET | `/api/inventory/levels` | `inventory.stock.read` |
| GET | `/api/inventory/stock` | `inventory.stock.read` |
| GET | `/api/inventory/summary` | `inventory.stock.read` |
| GET | `/api/inventory/items/:id` | `inventory.stock.read` |
| GET | `/api/inventory/items/:id/card` | `inventory.stock.read` |
| GET | `/api/inventory/by-source` | `inventory.stock.read` |
| GET | `/api/inventory/operations` | `inventory.stock.read` |
| GET | `/api/inventory/operations/:id` | `inventory.stock.read` |
| POST | `/api/inventory/operations` | `inventory.operations.write` |
| PUT | `/api/inventory/operations/:id` | `inventory.operations.write` |
| POST | `/api/inventory/operations/:id/post` | `inventory.operations.post` |
| POST | `/api/inventory/operations/:id/void` | `inventory.operations.post` |
| DELETE | `/api/inventory/operations/:id` | `inventory.operations.write` |
| GET | `/api/inventory/reports/valuation` | `inventory.stock.read` |
| GET | `/api/inventory/reports/movement` | `inventory.stock.read` |
| GET | `/api/inventory/reports/reorder` | `inventory.stock.read` |
| GET | `/api/inventory/reports/profitability` | `inventory.stock.read` |
| GET | `/api/inventory/lots` | `inventory.stock.read` |
| GET | `/api/inventory/reports/expiry` | `inventory.stock.read` |
| GET | `/api/inventory/trace` | `inventory.stock.read` |
| GET | `/api/inventory/receipts` | `inventory.receipts.read` |
| GET | `/api/inventory/receipts/:id` | `inventory.receipts.read` |
| POST | `/api/inventory/receipts` | `inventory.receipts.write` |
| PUT | `/api/inventory/receipts/:id` | `inventory.receipts.write` |
| POST | `/api/inventory/receipts/:id/post` | `inventory.receipts.post` |
| POST | `/api/inventory/receipts/:id/void` | `inventory.receipts.post` |
| DELETE | `/api/inventory/receipts/:id` | `inventory.receipts.write` |
| GET | `/api/inventory/reports/grni` | `inventory.receipts.read` |
| GET | `/api/inventory/landed-costs` | `inventory.stock.read` |
| GET | `/api/inventory/landed-costs/candidates` | `inventory.stock.read` |
| GET | `/api/inventory/landed-costs/:id` | `inventory.stock.read` |
| POST | `/api/inventory/landed-costs` | `inventory.landed.write` |
| PUT | `/api/inventory/landed-costs/:id` | `inventory.landed.write` |
| POST | `/api/inventory/landed-costs/:id/post` | `inventory.landed.post` |
| POST | `/api/inventory/landed-costs/:id/void` | `inventory.landed.post` |
| DELETE | `/api/inventory/landed-costs/:id` | `inventory.landed.write` |

</details>

### `purchasing` — apps/server/src/modules/purchasing/

- **Apps:** `purchasing` · **Depends on:** `documents`, `parties`, `catalog` · **Health checks:** yes
- **Permissions:** `purchasing.orders.read`, `purchasing.orders.write`, `purchasing.orders.approve`
- **Role templates:** `purchasing_officer`
- **Duties to split:** `purchasing.orders.write × purchasing.orders.approve`
- **Tables / views:** `purchase_order_lines`, `purchase_orders`
- **Provides services:** `purchasing`
- **Events:** emits — · listens `document.posted`, `document.voided`, `stock.receipt.posted`, `stock.receipt.voided`
- **Files:** `index.ts` (408)

<details><summary>9 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/purchase-orders` | `purchasing.orders.read` |
| GET | `/api/purchase-orders/:id` | `purchasing.orders.read` |
| POST | `/api/purchase-orders` | `purchasing.orders.write` |
| PUT | `/api/purchase-orders/:id` | `purchasing.orders.write` |
| POST | `/api/purchase-orders/:id/approve` | `purchasing.orders.approve` |
| POST | `/api/purchase-orders/:id/close` | `purchasing.orders.write` |
| POST | `/api/purchase-orders/:id/reopen` | `purchasing.orders.write` |
| POST | `/api/purchase-orders/:id/cancel` | `purchasing.orders.write` |
| DELETE | `/api/purchase-orders/:id` | `purchasing.orders.write` |

</details>

### `pricing` — apps/server/src/modules/pricing/

- **Apps:** `pricing` · **Depends on:** `catalog`, `parties`, `documents` · **Health checks:** no
- **Permissions:** `pricing.lists.read`, `pricing.lists.write`, `pricing.minprice.override`
- **Tables / views:** `party_price_lists`, `price_list_prices`, `price_lists`
- **Provides services:** —
- **Events:** emits — · listens `document.posted`
- **Files:** `index.ts` (179)

<details><summary>6 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/pricing/lists` | `pricing.lists.read` |
| GET | `/api/pricing/lists/:id` | `pricing.lists.read` |
| POST | `/api/pricing/lists` | `pricing.lists.write` |
| PUT | `/api/pricing/lists/:id` | `pricing.lists.write` |
| DELETE | `/api/pricing/lists/:id` | `pricing.lists.write` |
| GET | `/api/pricing/for-party/:id` | `auth` |

</details>

### `tax` — apps/server/src/modules/tax/

- **Apps:** `tax` · **Depends on:** `ledger`, `catalog` · **Health checks:** no
- **Permissions:** `tax.codes.read`, `tax.codes.write`, `tax.reports.read`
- **Tables / views:** —
- **Provides services:** `tax`
- **Events:** emits — · listens `system.setup`
- **Files:** `index.ts` (140)

<details><summary>4 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/taxes` | `auth` |
| POST | `/api/taxes` | `tax.codes.write` |
| PUT | `/api/taxes/:id` | `tax.codes.write` |
| GET | `/api/reports/tax-summary` | `tax.reports.read` |

</details>

### `ar` — apps/server/src/modules/ar/

- **Apps:** `ar` · **Depends on:** `documents`, `parties`, `catalog` · **Health checks:** no
- **Permissions:** `ar.customers.read`, `ar.customers.write`, `ar.invoices.read`, `ar.invoices.write`, `ar.invoices.post`, `ar.credits.read`, `ar.credits.write`, `ar.credits.post`, `ar.reports.read`
- **Role templates:** `sales_clerk`, `receivables_accountant`
- **Tables / views:** —
- **Provides services:** —
- **Files:** `index.ts` (43)

### `ap` — apps/server/src/modules/ap/

- **Apps:** `ap` · **Depends on:** `documents`, `parties`, `catalog` · **Health checks:** no
- **Permissions:** `ap.suppliers.read`, `ap.suppliers.write`, `ap.bills.read`, `ap.bills.write`, `ap.bills.post`, `ap.debits.read`, `ap.debits.write`, `ap.debits.post`, `ap.reports.read`
- **Role templates:** `payables_accountant`
- **Tables / views:** —
- **Provides services:** —
- **Files:** `index.ts` (37)

### `co` — apps/server/src/modules/co/

- **Apps:** `co` · **Depends on:** `ledger` · **Health checks:** yes
- **Permissions:** `co.costcenters.read`, `co.costcenters.write`, `co.reports.read`
- **Role templates:** `controller`
- **Tables / views:** `cost_centers`
- **Provides services:** `costCenters`
- **Files:** `index.ts` (150)

<details><summary>5 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/cost-centers` | `auth` |
| POST | `/api/cost-centers` | `co.costcenters.write` |
| PUT | `/api/cost-centers/:id` | `co.costcenters.write` |
| DELETE | `/api/cost-centers/:id` | `co.costcenters.write` |
| GET | `/api/reports/cost-centers` | `co.reports.read` |

</details>

## Web layout

| Folder | Files | What lives there |
|---|---|---|
| `apps/web/src/core/` | 15 | session, API client, i18n (en/ar dictionaries), formatting, module registry |
| `apps/web/src/ui/` | 20 | design-system widgets shared by every module (DataGrid, pickers, dialogs, stock, cost centers) |
| `apps/web/src/engines/` | 9 | shared screens used by several apps (documents, parties) |
| `apps/web/src/shell/` | 4 | sidebar / top bar, command palette, layout |

## Web modules

| Module | Apps | Pages | Files |
|---|---|---|---|
| `dashboard` | — | `/` | 1 (268 lines) |
| `gl` | — | `/accounts`, `/journal`, `/journal/:id`, `/journal/:id/edit`, `/journal/new`, `/reports`, `/reports/balance-sheet`, `/reports/cash-flow`, `/reports/general-ledger`, `/reports/income-statement`, `/reports/trial-balance` | 9 (1666 lines) |
| `tax` | `tax` | `/reports/tax`, `/taxes` | 1 (264 lines) |
| `ar` | `ar` | `/customers`, `/customers/:id`, `/documents/:id`, `/reports/aging/receivable` | 1 (40 lines) |
| `ap` | `ap` | `/documents/:id`, `/reports/aging/payable`, `/suppliers`, `/suppliers/:id` | 1 (36 lines) |
| `treasury` | `treasury` | — | 3 (648 lines) |
| `co` | `co` | `/cost-centers`, `/reports/cost-centers` | 1 (232 lines) |
| `catalog` | — | `/items` | 1 (501 lines) |
| `inventory` | `inventory` | `/inventory`, `/inventory/items/:id`, `/inventory/landed-costs`, `/inventory/landed-costs/:id`, `/inventory/landed-costs/:id/edit`, `/inventory/landed-costs/new`, `/inventory/operations`, `/inventory/operations/:id`, `/inventory/operations/:id/edit`, `/inventory/operations/new`, `/inventory/receipts`, `/inventory/receipts/:id`, `/inventory/receipts/:id/edit`, `/inventory/receipts/new`, `/inventory/warehouses`, `/reports/inventory/expiry`, `/reports/inventory/grni`, `/reports/inventory/movement`, `/reports/inventory/profitability`, `/reports/inventory/reorder`, `/reports/inventory/trace`, `/reports/inventory/valuation` | 12 (3248 lines) |
| `purchasing` | `purchasing` | `/purchasing/orders`, `/purchasing/orders/:id`, `/purchasing/orders/:id/edit`, `/purchasing/orders/new` | 2 (565 lines) |
| `pricing` | `pricing` | `/sales/price-lists`, `/sales/price-lists/:id`, `/sales/price-lists/new` | 1 (338 lines) |
| `admin` | — | `/access`, `/apps`, `/audit`, `/settings`, `/system/health` | 4 (1293 lines) |
