# Program map

> **Generated from the code by `npm run docs:map` — do not edit by hand.**
> A test fails when this file is out of date, so it always matches the code.

Where to find things: pick the module, then the file. Modules talk only through
`kernel/`, `contracts/`, services and events (see [ARCHITECTURE](ARCHITECTURE.md)).

## Apps → modules

| App | Server modules | Needs | Permission prefixes |
|---|---|---|---|
| **gl** (core) | `system`, `ledger` | — | `admin`, `gl` |
| **eco** | `eco` | — | `eco` |
| **treasury** | `payments`, `bank` | — | `treasury` |
| **inventory** | `inventory` | — | `inventory`, `catalog` |
| **purchasing** | `purchasing` | `ap` | `purchasing` |
| **pricing** | `pricing` | `ar` | `pricing` |
| **sd** | `sales` | `ar` | `sales` |
| **sop** | `sop` | `sd` | `sop` |
| **tax** | `tax` | — | `tax` |
| **ar** | `ar` | — | `ar`, `catalog` |
| **ap** | `ap` | — | `ap`, `catalog` |
| **co** | `co` | — | `co` |
| **fx** | `fx` | — | `fx` |
| **analysis** | `analysis` | — | `analysis` |
| **budget** | `budget` | — | `budget` |
| **cashflow** | `cashflow` | — | `cashflow` |
| **mfg** | `manufacturing` | `inventory` | `mfg` |
| **assets** | `assets` | — | `assets` |
| **payroll** | `payroll` | — | `payroll` |
| **cheques** | `cheques` | — | `cheques` |
| **recurring** | `recurring` | — | `recurring` |
| **imports** | `imports` | — | `imports` |
| **einvoice** | `einvoice` | `ar` | `einvoice` |
| **advisor** | `advisor` | — | `advisor` |

Engines (no app of their own, pulled in by `dependsOn`): `parties`, `catalog`, `documents`

## Server layout

| Folder | Files | What lives there |
|---|---|---|
| `apps/server/src/kernel/` | 12 | the chassis: db adapter, module loader, services, events, apps, money, dates, validation |
| `apps/server/src/contracts/` | 14 | shared types and constants modules use to talk to each other |
| `apps/server/src/eco-contracts/` | 11 | ecosystem contracts vendored byte for byte from GMES (pinned in PIN.json, never edited here) |
| `apps/server/src/modules/` | 77 | one folder per module (below) |
| `apps/server/src/test/` | 34 | end-to-end tests, boundary and edition tests |

Contracts: `budget.ts`, `catalog.ts`, `co.ts`, `documents.ts`, `eco.ts`, `egypt.ts`, `fx.ts`, `inventory.ts`, `parties.ts`, `pricing.ts`, `purchasing.ts`, `sales.ts`, `sop.ts`, `tax.ts`

## Server modules (in load order)

### `system` — apps/server/src/modules/system/

- **Apps:** `gl` · **Depends on:** — · **Health checks:** yes
- **Permissions:** `admin.settings.read`, `admin.settings.manage`, `admin.users.manage`, `admin.audit.read`, `admin.backup.manage`
- **Tables / views:** `audit_log`, `role_permissions`, `roles`, `sequences`, `sessions`, `settings`, `user_roles`, `users`
- **Provides services:** `access`, `audit`, `backup`, `sequences`, `settings`
- **Events:** emits `system.setup` · listens —
- **Files:** `auth.ts` (189), `index.ts` (511), `rehearsal.ts` (51), `schema.ts` (95), `settings.ts` (117)

<details><summary>26 routes</summary>

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
| POST | `/api/system/backups/:name/verify` | `admin.backup.manage` |
| GET | `/api/system/backups/:name` | `admin.backup.manage` |

</details>

### `ledger` — apps/server/src/modules/ledger/

- **Apps:** `gl` · **Depends on:** `system` · **Health checks:** yes
- **Permissions:** `gl.accounts.read`, `gl.accounts.write`, `gl.journal.read`, `gl.journal.write`, `gl.journal.post`, `gl.fiscal.manage`, `gl.reports.read`
- **Role templates:** `bookkeeper`
- **Tables / views:** `accounts`, `fiscal_years`, `journal_entries`, `journal_lines`, `ledger`
- **Provides services:** `ledger`
- **Events:** emits `fiscalYear.closed`, `journal.posted`, `journal.reversed` · listens `system.setup`
- **Files:** `chart-template.ts` (195), `index.ts` (252), `reports.ts` (209), `schema.ts` (180), `service.ts` (755), `statements.ts` (268)

<details><summary>25 routes</summary>

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
| GET | `/api/reports/equity-changes` | `gl.reports.read` |
| GET | `/api/reports/dashboard` | `gl.reports.read` |

</details>

### `eco` — apps/server/src/modules/eco/

- **Apps:** `eco` · **Depends on:** `system`, `ledger` · **Health checks:** yes
- **Permissions:** `eco.events.read`, `eco.settings.manage`
- **Role templates:** `integration_admin`
- **Tables / views:** `eco_ack`, `eco_company`, `eco_inbox`, `eco_inbox_rejects`, `eco_keys`, `eco_outbox`, `eco_peers`, `eco_snapshots`, `eco_supply_plan`, `eco_supply_plans`
- **Provides services:** `eco`
- **Files:** `index.ts` (249), `keys.ts` (79), `peers.ts` (195), `schema.ts` (159), `service.ts` (244)

<details><summary>20 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/eco/company` | `auth` |
| GET | `/api/eco/status` | `eco.events.read` |
| GET | `/api/eco/keys` | `eco.settings.manage` |
| POST | `/api/eco/keys` | `eco.settings.manage` |
| POST | `/api/eco/keys/:id/revoke` | `eco.settings.manage` |
| GET | `/api/eco/scopes` | `eco.settings.manage` |
| POST | `/api/eco/resync` | `eco.settings.manage` |
| GET | `/api/eco/peers` | `eco.settings.manage` |
| POST | `/api/eco/peers` | `eco.settings.manage` |
| PUT | `/api/eco/peers/:id` | `eco.settings.manage` |
| DELETE | `/api/eco/peers/:id` | `eco.settings.manage` |
| POST | `/api/eco/peers/:id/sync` | `eco.settings.manage` |
| POST | `/api/eco/sync` | `eco.settings.manage` |
| GET | `/api/eco/supply-plan` | `eco.events.read` |
| GET | `/api/integration/events` | `eco.events.read` |
| GET | `/api/integration/inbox` | `eco.events.read` |
| GET | `/eco/v1/feed` | `key: eco.feed.read` |
| POST | `/eco/v1/acks` | `key: eco.acks.write` |
| POST | `/eco/v1/inbox` | `key: eco.inbox.write` |
| GET | `/eco/v1/events` | `key: eco.events.read` |

</details>

### `parties` — apps/server/src/modules/parties/

- **Apps:** — · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** —
- **Tables / views:** `parties`
- **Provides services:** `parties`
- **Events:** emits — · listens `system.setup`
- **Files:** `index.ts` (329)

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
- **Files:** `index.ts` (469)

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
- **Tables / views:** `document_lines`, `documents`, `settlements`, `settlements_new`
- **Provides services:** `documents`
- **Events:** emits `document.posted`, `document.voided` · listens `system.setup`
- **Files:** `index.ts` (306), `schema.ts` (218), `service.ts` (446)

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
- **Files:** `index.ts` (637)

<details><summary>10 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payments/accounts` | `auth` |
| GET | `/api/payments/open-documents` | `auth` |
| GET | `/api/payments` | `auth` |
| GET | `/api/payments/:id` | `auth` |
| POST | `/api/payments/withholding` | `auth` |
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
- **Tables / views:** `goods_receipt_lines`, `goods_receipts`, `landed_cost_allocations`, `landed_cost_targets`, `landed_costs`, `lot_levels`, `receipt_matches`, `stock_doc_lines`, `stock_docs`, `stock_levels`, `stock_lots`, `stock_moves`, `stock_moves_v2`, `stock_quarantine`, `stock_values`, `warehouses`
- **Provides services:** `inventory`
- **Events:** emits `stock.receipt.posted`, `stock.receipt.voided` · listens `document.posted`, `document.voided`, `stock.receipt.posted`, `stock.receipt.voided`
- **Files:** `eco.ts` (190), `engine.ts` (558), `index.ts` (887), `schema.ts` (336), `service.ts` (1129)

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
- **Permissions:** `purchasing.orders.read`, `purchasing.orders.write`, `purchasing.orders.approve`, `purchasing.requisitions.read`, `purchasing.requisitions.write`, `purchasing.lc.read`, `purchasing.lc.write`, `purchasing.reports.read`
- **Role templates:** `purchasing_officer`, `import_officer`
- **Duties to split:** `purchasing.orders.write × purchasing.orders.approve`, `purchasing.lc.write × purchasing.orders.approve`
- **Tables / views:** `lc_events`, `letters_of_credit`, `purchase_order_lines`, `purchase_orders`, `purchase_requisitions`
- **Provides services:** `purchaseSupply`, `purchasing`
- **Events:** emits — · listens `document.posted`, `document.voided`, `stock.receipt.posted`, `stock.receipt.voided`
- **Files:** `eco.ts` (65), `index.ts` (214), `lc.ts` (353), `orders.ts` (327), `reports.ts` (90), `requisitions.ts` (277), `schema.ts` (154)

<details><summary>27 routes</summary>

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
| GET | `/api/letters-of-credit` | `purchasing.lc.read` |
| GET | `/api/letters-of-credit/:id` | `purchasing.lc.read` |
| POST | `/api/letters-of-credit` | `purchasing.lc.write` |
| POST | `/api/letters-of-credit/:id/charges` | `purchasing.lc.write` |
| POST | `/api/letters-of-credit/:id/documents` | `purchasing.lc.write` |
| POST | `/api/letters-of-credit/:id/settle` | `purchasing.lc.write` |
| POST | `/api/letters-of-credit/:id/repay` | `purchasing.lc.write` |
| POST | `/api/letters-of-credit/:id/close` | `purchasing.lc.write` |
| GET | `/api/purchasing/reports/supplier-on-time` | `purchasing.reports.read` |
| GET | `/api/purchasing/reports/open-orders` | `purchasing.reports.read` |
| GET | `/api/purchase-requisitions` | `purchasing.requisitions.read` |
| GET | `/api/purchase-requisitions/:id` | `purchasing.requisitions.read` |
| POST | `/api/purchase-requisitions` | `purchasing.requisitions.write` |
| PUT | `/api/purchase-requisitions/:id` | `purchasing.requisitions.write` |
| POST | `/api/purchase-requisitions/:id/cancel` | `purchasing.requisitions.write` |
| POST | `/api/purchase-requisitions/:id/close` | `purchasing.requisitions.write` |
| POST | `/api/purchase-requisitions/:id/reopen` | `purchasing.requisitions.write` |
| POST | `/api/purchase-requisitions/convert` | `purchasing.orders.write` |

</details>

### `pricing` — apps/server/src/modules/pricing/

- **Apps:** `pricing` · **Depends on:** `catalog`, `parties`, `documents` · **Health checks:** no
- **Permissions:** `pricing.lists.read`, `pricing.lists.write`, `pricing.minprice.override`
- **Tables / views:** `party_price_lists`, `price_list_prices`, `price_lists`
- **Provides services:** `pricing`
- **Events:** emits — · listens `document.posted`
- **Files:** `index.ts` (198)

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

### `sales` — apps/server/src/modules/sales/

- **Apps:** `sd` · **Depends on:** `documents`, `parties`, `catalog` · **Health checks:** yes
- **Permissions:** `sales.orders.read`, `sales.orders.write`, `sales.orders.approve`, `sales.orders.override`, `sales.deliveries.read`, `sales.deliveries.write`, `sales.deliveries.post`, `sales.reports.read`, `sales.supply.write`
- **Role templates:** `sales_order_clerk`, `shipping_clerk`, `sales_manager`
- **Duties to split:** `sales.orders.write × sales.orders.override`
- **Tables / views:** `sales_deliveries`, `sales_delivery_lines`, `sales_order_lines`, `sales_orders`, `sales_reservations`, `sales_supply_plan`
- **Provides services:** `sales`
- **Events:** emits `sales.delivery.posted`, `sales.delivery.voided`, `sales.order.confirmed` · listens `document.posted`, `document.voided`
- **Files:** `eco.ts` (91), `index.ts` (397), `reports.ts` (263), `schema.ts` (146), `service.ts` (899)

<details><summary>28 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/sales/orders` | `sales.orders.read` |
| GET | `/api/sales/orders/:id` | `sales.orders.read` |
| POST | `/api/sales/orders` | `sales.orders.write` |
| PUT | `/api/sales/orders/:id` | `sales.orders.write` |
| POST | `/api/sales/orders/:id/confirm` | `sales.orders.approve` |
| POST | `/api/sales/orders/:id/cancel` | `sales.orders.write` |
| POST | `/api/sales/orders/:id/close` | `sales.orders.write` |
| POST | `/api/sales/orders/:id/reschedule` | `sales.orders.approve` |
| PUT | `/api/sales/orders/:id/lines/:lineId/promise` | `sales.orders.approve` |
| DELETE | `/api/sales/orders/:id` | `sales.orders.write` |
| GET | `/api/sales/price` | `sales.orders.read` |
| GET | `/api/sales/atp` | `sales.orders.read` |
| GET | `/api/sales/reservations` | `sales.orders.read` |
| GET | `/api/sales/supply-plan` | `sales.orders.read` |
| PUT | `/api/sales/supply-plan` | `sales.supply.write` |
| GET | `/api/sales/deliveries` | `sales.deliveries.read` |
| GET | `/api/sales/deliveries/:id` | `sales.deliveries.read` |
| POST | `/api/sales/deliveries` | `sales.deliveries.write` |
| PUT | `/api/sales/deliveries/:id` | `sales.deliveries.write` |
| POST | `/api/sales/deliveries/:id/post` | `sales.deliveries.post` |
| POST | `/api/sales/deliveries/:id/void` | `sales.deliveries.post` |
| DELETE | `/api/sales/deliveries/:id` | `sales.deliveries.write` |
| POST | `/api/sales/deliveries/deliver-line` | `sales.deliveries.post` |
| POST | `/api/sales/invoices/from-deliveries` | `sales.deliveries.read` |
| GET | `/api/sales/reports/otif` | `sales.reports.read` |
| GET | `/api/sales/reports/backlog` | `sales.reports.read` |
| GET | `/api/sales/reports/aging` | `sales.reports.read` |
| GET | `/api/sales/reports/sales` | `sales.reports.read` |

</details>

### `sop` — apps/server/src/modules/sop/

- **Apps:** `sop` · **Depends on:** `sales`, `catalog` · **Health checks:** no
- **Permissions:** `sop.plans.read`, `sop.plans.write`, `sop.plans.approve`, `sop.supply.write`
- **Role templates:** `demand_planner`, `sop_approver`
- **Duties to split:** `sop.plans.write × sop.plans.approve`
- **Tables / views:** `sop_cycles`, `sop_demand`, `sop_supply_plan`, `sop_versions`
- **Provides services:** `sop`
- **Events:** emits `sop.plan.approved` · listens —
- **Files:** `eco.ts` (37), `index.ts` (134), `kpi.ts` (109), `schema.ts` (87), `service.ts` (329)

<details><summary>15 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/sop/cycles` | `sop.plans.read` |
| POST | `/api/sop/cycles` | `sop.plans.write` |
| GET | `/api/sop/cycles/:id` | `sop.plans.read` |
| POST | `/api/sop/cycles/:id/versions` | `sop.plans.write` |
| GET | `/api/sop/versions/:id` | `sop.plans.read` |
| PUT | `/api/sop/versions/:id/lines` | `sop.plans.write` |
| POST | `/api/sop/versions/:id/refresh` | `sop.plans.write` |
| POST | `/api/sop/versions/:id/approve` | `sop.plans.approve` |
| DELETE | `/api/sop/versions/:id` | `sop.plans.write` |
| GET | `/api/sop/versions/:id/comparison` | `sop.plans.read` |
| GET | `/api/sop/versions/:id/executive` | `sop.plans.read` |
| GET | `/api/kpi/pack` | `sop.plans.read` |
| GET | `/api/sop/approved` | `sop.plans.read` |
| GET | `/api/sop/supply` | `sop.plans.read` |
| PUT | `/api/sop/supply` | `sop.supply.write` |

</details>

### `tax` — apps/server/src/modules/tax/

- **Apps:** `tax` · **Depends on:** `ledger`, `catalog` · **Health checks:** no
- **Permissions:** `tax.codes.read`, `tax.codes.write`, `tax.reports.read`
- **Tables / views:** —
- **Provides services:** `tax`
- **Events:** emits — · listens `system.setup`
- **Files:** `index.ts` (197)

<details><summary>7 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/taxes` | `auth` |
| POST | `/api/taxes` | `tax.codes.write` |
| PUT | `/api/taxes/:id` | `tax.codes.write` |
| GET | `/api/tax/withholding` | `auth` |
| PUT | `/api/tax/withholding` | `tax.codes.write` |
| GET | `/api/reports/withholding` | `tax.reports.read` |
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

### `bank` — apps/server/src/modules/bank/

- **Apps:** `treasury` · **Depends on:** `ledger` · **Health checks:** yes
- **Permissions:** `treasury.transfers.read`, `treasury.transfers.write`, `treasury.transfers.post`, `treasury.statements.read`, `treasury.statements.write`, `treasury.statements.post`
- **Tables / views:** `bank_statement_lines`, `bank_statements`, `bank_transfers`
- **Provides services:** —
- **Events:** emits — · listens `journal.reversed`
- **Files:** `index.ts` (226), `schema.ts` (73), `service.ts` (482)

<details><summary>22 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/bank/accounts` | `auth` |
| GET | `/api/bank/transfers` | `treasury.transfers.read` |
| GET | `/api/bank/transfers/:id` | `treasury.transfers.read` |
| POST | `/api/bank/transfers` | `treasury.transfers.write` |
| PUT | `/api/bank/transfers/:id` | `treasury.transfers.write` |
| POST | `/api/bank/transfers/:id/post` | `treasury.transfers.post` |
| POST | `/api/bank/transfers/:id/void` | `treasury.transfers.post` |
| DELETE | `/api/bank/transfers/:id` | `treasury.transfers.write` |
| GET | `/api/bank/statements` | `treasury.statements.read` |
| GET | `/api/bank/statements/next` | `treasury.statements.read` |
| GET | `/api/bank/statements/:id` | `treasury.statements.read` |
| POST | `/api/bank/statements` | `treasury.statements.write` |
| PUT | `/api/bank/statements/:id` | `treasury.statements.write` |
| POST | `/api/bank/statements/:id/lines` | `treasury.statements.write` |
| DELETE | `/api/bank/statement-lines/:id` | `treasury.statements.write` |
| POST | `/api/bank/statements/:id/auto-match` | `treasury.statements.write` |
| POST | `/api/bank/statement-lines/:id/match` | `treasury.statements.write` |
| POST | `/api/bank/statement-lines/:id/unmatch` | `treasury.statements.write` |
| POST | `/api/bank/statement-lines/:id/entry` | `treasury.statements.write` |
| POST | `/api/bank/statements/:id/reconcile` | `treasury.statements.post` |
| POST | `/api/bank/statements/:id/reopen` | `treasury.statements.post` |
| DELETE | `/api/bank/statements/:id` | `treasury.statements.write` |

</details>

### `fx` — apps/server/src/modules/fx/

- **Apps:** `fx` · **Depends on:** `ledger` · **Health checks:** yes
- **Permissions:** `fx.rates.write`, `fx.revaluations.read`, `fx.revaluations.post`
- **Role templates:** `treasurer`
- **Tables / views:** `currencies`, `exchange_rates`, `fx_revaluations`
- **Provides services:** `fx`
- **Events:** emits — · listens `system.setup`
- **Files:** `index.ts` (298)

<details><summary>10 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/currencies` | `auth` |
| POST | `/api/currencies` | `fx.rates.write` |
| PUT | `/api/currencies/:code` | `fx.rates.write` |
| GET | `/api/fx/rates` | `auth` |
| GET | `/api/fx/rate` | `auth` |
| POST | `/api/fx/rates` | `fx.rates.write` |
| DELETE | `/api/fx/rates/:id` | `fx.rates.write` |
| GET | `/api/fx/revaluations` | `fx.revaluations.read` |
| GET | `/api/fx/revaluations/preview` | `fx.revaluations.read` |
| POST | `/api/fx/revaluations` | `fx.revaluations.post` |

</details>

### `analysis` — apps/server/src/modules/analysis/

- **Apps:** `analysis` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `analysis.reports.read`, `analysis.settings.manage`
- **Role templates:** `financial_analyst`
- **Tables / views:** —
- **Provides services:** —
- **Files:** `engine.ts` (395), `index.ts` (267)

<details><summary>5 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/analysis` | `analysis.reports.read` |
| GET | `/api/analysis/trend` | `analysis.reports.read` |
| GET | `/api/analysis/settings` | `analysis.reports.read` |
| PUT | `/api/analysis/settings` | `analysis.settings.manage` |
| GET | `/api/analysis/break-even` | `analysis.reports.read` |

</details>

### `budget` — apps/server/src/modules/budget/

- **Apps:** `budget` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `budget.budgets.read`, `budget.budgets.write`, `budget.budgets.approve`, `budget.reports.read`
- **Role templates:** `budget_controller`
- **Duties to split:** `budget.budgets.write × budget.budgets.approve`
- **Tables / views:** `budget_lines`, `budget_sales`, `budgets`
- **Provides services:** `budgetSales`
- **Files:** `engine.ts` (163), `index.ts` (421)

<details><summary>11 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/budgets` | `budget.budgets.read` |
| GET | `/api/budgets/:id` | `budget.budgets.read` |
| POST | `/api/budgets` | `budget.budgets.write` |
| PUT | `/api/budgets/:id` | `budget.budgets.write` |
| PUT | `/api/budgets/:id/lines` | `budget.budgets.write` |
| PUT | `/api/budgets/:id/sales` | `budget.budgets.write` |
| POST | `/api/budgets/:id/approve` | `budget.budgets.approve` |
| POST | `/api/budgets/:id/reopen` | `budget.budgets.approve` |
| DELETE | `/api/budgets/:id` | `budget.budgets.write` |
| GET | `/api/budgets/:id/variance` | `budget.reports.read` |
| GET | `/api/budgets/:id/sales-variance` | `budget.reports.read` |

</details>

### `cashflow` — apps/server/src/modules/cashflow/

- **Apps:** `cashflow` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `cashflow.forecast.read`, `cashflow.plan.write`
- **Role templates:** `cash_manager`
- **Tables / views:** `cash_plan`, `cashflow_settings`
- **Provides services:** —
- **Files:** `engine.ts` (149), `index.ts` (301)

<details><summary>8 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/cashflow/forecast` | `cashflow.forecast.read` |
| GET | `/api/cashflow/plan` | `cashflow.forecast.read` |
| POST | `/api/cashflow/plan` | `cashflow.plan.write` |
| PUT | `/api/cashflow/plan/:id` | `cashflow.plan.write` |
| DELETE | `/api/cashflow/plan/:id` | `cashflow.plan.write` |
| GET | `/api/cashflow/settings` | `cashflow.forecast.read` |
| PUT | `/api/cashflow/settings` | `cashflow.plan.write` |
| GET | `/api/cashflow/suggestions` | `cashflow.plan.write` |

</details>

### `manufacturing` — apps/server/src/modules/manufacturing/

- **Apps:** `mfg` · **Depends on:** `ledger`, `catalog`, `inventory` · **Health checks:** yes
- **Permissions:** `mfg.boms.read`, `mfg.boms.write`, `mfg.orders.read`, `mfg.orders.write`, `mfg.orders.post`, `mfg.reports.read`, `mfg.settings.manage`
- **Role templates:** `production_planner`
- **Tables / views:** `bom_lines`, `boms`, `mfg_settings`, `mfg_wip`, `production_order_lines`, `production_orders`
- **Provides services:** —
- **Files:** `engine.ts` (184), `gmes.ts` (127), `index.ts` (631)

<details><summary>17 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/mfg/gmes-wip` | `mfg.reports.read` |
| GET | `/api/mfg/boms` | `mfg.boms.read` |
| GET | `/api/mfg/boms/:id` | `mfg.boms.read` |
| POST | `/api/mfg/boms` | `mfg.boms.write` |
| PUT | `/api/mfg/boms/:id` | `mfg.boms.write` |
| DELETE | `/api/mfg/boms/:id` | `mfg.boms.write` |
| POST | `/api/mfg/boms/:id/update-standards` | `mfg.boms.write` |
| GET | `/api/mfg/orders` | `mfg.orders.read` |
| GET | `/api/mfg/orders/:id` | `mfg.orders.read` |
| POST | `/api/mfg/orders` | `mfg.orders.write` |
| PUT | `/api/mfg/orders/:id` | `mfg.orders.write` |
| POST | `/api/mfg/orders/:id/complete` | `mfg.orders.post` |
| POST | `/api/mfg/orders/:id/void` | `mfg.orders.post` |
| DELETE | `/api/mfg/orders/:id` | `mfg.orders.write` |
| GET | `/api/mfg/variances` | `mfg.reports.read` |
| GET | `/api/mfg/settings` | `mfg.orders.read` |
| PUT | `/api/mfg/settings` | `mfg.settings.manage` |

</details>

### `assets` — apps/server/src/modules/assets/

- **Apps:** `assets` · **Depends on:** `ledger` · **Health checks:** yes
- **Permissions:** `assets.register.read`, `assets.register.write`, `assets.depreciation.post`, `assets.reports.read`
- **Role templates:** `asset_accountant`
- **Tables / views:** `asset_categories`, `asset_settings`, `assets`, `depreciation_lines`, `depreciation_runs`
- **Provides services:** —
- **Files:** `engine.ts` (91), `index.ts` (614)

<details><summary>15 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/assets/categories` | `assets.register.read` |
| POST | `/api/assets/categories` | `assets.register.write` |
| PUT | `/api/assets/categories/:id` | `assets.register.write` |
| GET | `/api/assets` | `assets.register.read` |
| GET | `/api/assets/depreciation/runs` | `assets.register.read` |
| GET | `/api/assets/depreciation/preview` | `assets.register.read` |
| POST | `/api/assets/depreciation/run` | `assets.depreciation.post` |
| POST | `/api/assets/depreciation/runs/:id/undo` | `assets.depreciation.post` |
| GET | `/api/assets/report` | `assets.reports.read` |
| GET | `/api/assets/:id` | `assets.register.read` |
| POST | `/api/assets` | `assets.register.write` |
| PUT | `/api/assets/:id` | `assets.register.write` |
| DELETE | `/api/assets/:id` | `assets.register.write` |
| POST | `/api/assets/:id/dispose` | `assets.depreciation.post` |
| POST | `/api/assets/:id/undo-disposal` | `assets.depreciation.post` |

</details>

### `payroll` — apps/server/src/modules/payroll/

- **Apps:** `payroll` · **Depends on:** `ledger` · **Health checks:** yes
- **Permissions:** `payroll.employees.read`, `payroll.employees.write`, `payroll.runs.read`, `payroll.runs.write`, `payroll.runs.post`, `payroll.settings.manage`
- **Role templates:** `payroll_officer`
- **Duties to split:** `payroll.employees.write × payroll.runs.post`
- **Tables / views:** `employee_components`, `employees`, `pay_components`, `payroll_account_map`, `payroll_hr_period`, `payroll_lines`, `payroll_runs`, `payroll_settings`
- **Provides services:** —
- **Files:** `engine.ts` (184), `hr.ts` (148), `index.ts` (725)

<details><summary>24 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payroll/employees` | `payroll.employees.read` |
| GET | `/api/payroll/employees/:id` | `payroll.employees.read` |
| POST | `/api/payroll/employees` | `payroll.employees.write` |
| PUT | `/api/payroll/employees/:id` | `payroll.employees.write` |
| DELETE | `/api/payroll/employees/:id` | `payroll.employees.write` |
| GET | `/api/payroll/components` | `payroll.employees.read` |
| POST | `/api/payroll/components/egypt` | `payroll.settings.manage` |
| POST | `/api/payroll/components` | `payroll.settings.manage` |
| PUT | `/api/payroll/components/:id` | `payroll.settings.manage` |
| GET | `/api/payroll/runs` | `payroll.runs.read` |
| GET | `/api/payroll/runs/:id` | `payroll.runs.read` |
| GET | `/api/payroll/source` | `payroll.runs.read` |
| PUT | `/api/payroll/source` | `payroll.settings.manage` |
| GET | `/api/payroll/account-map` | `payroll.settings.manage` |
| PUT | `/api/payroll/account-map` | `payroll.settings.manage` |
| POST | `/api/payroll/runs` | `payroll.runs.write` |
| PUT | `/api/payroll/runs/:id` | `payroll.runs.write` |
| POST | `/api/payroll/runs/:id/recalculate` | `payroll.runs.write` |
| PUT | `/api/payroll/runs/:id/lines/:lineId` | `payroll.runs.write` |
| POST | `/api/payroll/runs/:id/post` | `payroll.runs.post` |
| POST | `/api/payroll/runs/:id/unpost` | `payroll.runs.post` |
| POST | `/api/payroll/runs/:id/pay` | `payroll.runs.post` |
| POST | `/api/payroll/runs/:id/unpay` | `payroll.runs.post` |
| DELETE | `/api/payroll/runs/:id` | `payroll.runs.write` |

</details>

### `cheques` — apps/server/src/modules/cheques/

- **Apps:** `cheques` · **Depends on:** `ledger`, `parties`, `documents` · **Health checks:** yes
- **Permissions:** `cheques.received.read`, `cheques.received.write`, `cheques.issued.read`, `cheques.issued.write`
- **Role templates:** `cheque_clerk`
- **Tables / views:** `cheque_allocations`, `cheque_settings`, `cheques`
- **Provides services:** —
- **Files:** `index.ts` (419)

<details><summary>9 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/cheques` | `auth` |
| GET | `/api/cheques/portfolio` | `auth` |
| GET | `/api/cheques/open-documents` | `auth` |
| GET | `/api/cheques/:id` | `auth` |
| POST | `/api/cheques` | `auth` |
| POST | `/api/cheques/:id/deposit` | `auth` |
| POST | `/api/cheques/:id/clear` | `auth` |
| POST | `/api/cheques/:id/unclear` | `auth` |
| POST | `/api/cheques/:id/cancel` | `auth` |

</details>

### `recurring` — apps/server/src/modules/recurring/

- **Apps:** `recurring` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `recurring.templates.read`, `recurring.templates.write`
- **Tables / views:** `recurring_runs`, `recurring_templates`
- **Provides services:** —
- **Files:** `engine.ts` (45), `index.ts` (332)

<details><summary>7 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/recurring` | `recurring.templates.read` |
| GET | `/api/recurring/due` | `recurring.templates.read` |
| GET | `/api/recurring/:id` | `recurring.templates.read` |
| POST | `/api/recurring` | `recurring.templates.write` |
| PUT | `/api/recurring/:id` | `recurring.templates.write` |
| DELETE | `/api/recurring/:id` | `recurring.templates.write` |
| POST | `/api/recurring/generate` | `recurring.templates.write` |

</details>

### `imports` — apps/server/src/modules/imports/

- **Apps:** `imports` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `imports.data.write`
- **Tables / views:** —
- **Provides services:** —
- **Files:** `index.ts` (422), `xlsx.ts` (278)

<details><summary>4 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/imports/datasets` | `imports.data.write` |
| GET | `/api/imports/template/:dataset` | `imports.data.write` |
| POST | `/api/imports/preview` | `imports.data.write` |
| POST | `/api/imports/commit` | `imports.data.write` |

</details>

### `einvoice` — apps/server/src/modules/einvoice/

- **Apps:** `einvoice` · **Depends on:** `ledger`, `parties`, `catalog`, `documents` · **Health checks:** yes
- **Permissions:** `einvoice.documents.read`, `einvoice.documents.post`, `einvoice.settings.manage`
- **Role templates:** `einvoice_clerk`
- **Tables / views:** `einvoice_documents`, `einvoice_item_codes`, `einvoice_settings`, `einvoice_tax_codes`
- **Provides services:** —
- **Events:** emits — · listens `document.posted`, `document.voided`
- **Files:** `eta.ts` (261), `index.ts` (518)

<details><summary>13 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/einvoice/settings` | `einvoice.settings.manage` |
| PUT | `/api/einvoice/settings` | `einvoice.settings.manage` |
| POST | `/api/einvoice/test` | `einvoice.settings.manage` |
| GET | `/api/einvoice/codes` | `einvoice.settings.manage` |
| PUT | `/api/einvoice/codes/items/:id` | `einvoice.settings.manage` |
| PUT | `/api/einvoice/codes/taxes/:id` | `einvoice.settings.manage` |
| GET | `/api/einvoice/documents` | `einvoice.documents.read` |
| GET | `/api/einvoice/documents/:id` | `einvoice.documents.read` |
| POST | `/api/einvoice/queue` | `einvoice.documents.post` |
| POST | `/api/einvoice/submit` | `einvoice.documents.post` |
| POST | `/api/einvoice/refresh` | `einvoice.documents.post` |
| POST | `/api/einvoice/documents/:id/cancel` | `einvoice.documents.post` |
| POST | `/api/einvoice/documents/:id/skip` | `einvoice.documents.post` |

</details>

### `advisor` — apps/server/src/modules/advisor/

- **Apps:** `advisor` · **Depends on:** `ledger` · **Health checks:** no
- **Permissions:** `advisor.findings.read`
- **Tables / views:** —
- **Provides services:** —
- **Files:** `checks.ts` (326), `index.ts` (29)

<details><summary>2 routes</summary>

| Method | Path | Permission |
|---|---|---|
| GET | `/api/advisor` | `advisor.findings.read` |
| GET | `/api/advisor/documents/:id` | `advisor.findings.read` |

</details>

## Web layout

| Folder | Files | What lives there |
|---|---|---|
| `apps/web/src/core/` | 15 | session, API client, i18n (en/ar dictionaries), formatting, module registry |
| `apps/web/src/ui/` | 21 | design-system widgets shared by every module (DataGrid, pickers, dialogs, stock, cost centers) |
| `apps/web/src/engines/` | 9 | shared screens used by several apps (documents, parties) |
| `apps/web/src/shell/` | 4 | sidebar / top bar, command palette, layout |

## Web modules

| Module | Apps | Pages | Files |
|---|---|---|---|
| `dashboard` | — | `/` | 1 (268 lines) |
| `gl` | — | `/accounts`, `/journal`, `/journal/:id`, `/journal/:id/edit`, `/journal/new`, `/reports`, `/reports/balance-sheet`, `/reports/cash-flow`, `/reports/equity-changes`, `/reports/general-ledger`, `/reports/income-statement`, `/reports/trial-balance` | 9 (1849 lines) |
| `tax` | `tax` | `/reports/tax`, `/reports/withholding`, `/taxes` | 2 (494 lines) |
| `ar` | `ar` | `/customers`, `/customers/:id`, `/documents/:id`, `/reports/aging/receivable` | 1 (41 lines) |
| `ap` | `ap` | `/documents/:id`, `/reports/aging/payable`, `/suppliers`, `/suppliers/:id` | 1 (37 lines) |
| `treasury` | `treasury` | `/bank`, `/bank/statements/:id`, `/bank/transfers` | 6 (1852 lines) |
| `co` | `co` | `/cost-centers`, `/reports/cost-centers` | 1 (235 lines) |
| `fx` | `fx` | `/currencies`, `/fx/revaluation` | 1 (305 lines) |
| `analysis` | `analysis` | `/analysis`, `/analysis/break-even`, `/analysis/trend` | 1 (499 lines) |
| `budget` | `budget` | `/budgets`, `/budgets/:id`, `/budgets/:id/variance` | 1 (989 lines) |
| `cashflow` | `cashflow` | `/cashflow`, `/cashflow/plan` | 1 (586 lines) |
| `manufacturing` | `mfg` | `/mfg/boms`, `/mfg/boms/:id`, `/mfg/orders`, `/mfg/orders/:id`, `/mfg/variances` | 1 (1005 lines) |
| `assets` | `assets` | `/fixed-assets`, `/fixed-assets/:id`, `/fixed-assets/categories`, `/fixed-assets/depreciation`, `/fixed-assets/report` | 1 (925 lines) |
| `payroll` | `payroll` | `/payroll/components`, `/payroll/employees`, `/payroll/employees/:id`, `/payroll/runs`, `/payroll/runs/:id` | 1 (1177 lines) |
| `cheques` | `cheques` | `/cheques/:id`, `/cheques/issued`, `/cheques/new`, `/cheques/portfolio`, `/cheques/received` | 1 (582 lines) |
| `recurring` | `recurring` | `/recurring`, `/recurring/:id` | 1 (641 lines) |
| `imports` | `imports` | `/import` | 1 (233 lines) |
| `einvoice` | `einvoice` | `/einvoice`, `/einvoice/settings` | 1 (540 lines) |
| `advisor` | `advisor` | `/advisor` | 1 (251 lines) |
| `catalog` | — | `/items` | 1 (572 lines) |
| `inventory` | `inventory` | `/inventory`, `/inventory/items/:id`, `/inventory/landed-costs`, `/inventory/landed-costs/:id`, `/inventory/landed-costs/:id/edit`, `/inventory/landed-costs/new`, `/inventory/operations`, `/inventory/operations/:id`, `/inventory/operations/:id/edit`, `/inventory/operations/new`, `/inventory/receipts`, `/inventory/receipts/:id`, `/inventory/receipts/:id/edit`, `/inventory/receipts/new`, `/inventory/warehouses`, `/reports/inventory/expiry`, `/reports/inventory/grni`, `/reports/inventory/movement`, `/reports/inventory/profitability`, `/reports/inventory/reorder`, `/reports/inventory/trace`, `/reports/inventory/valuation` | 12 (3254 lines) |
| `purchasing` | `purchasing` | `/purchasing/lc`, `/purchasing/lc/:id`, `/purchasing/orders`, `/purchasing/orders/:id`, `/purchasing/orders/:id/edit`, `/purchasing/orders/new`, `/purchasing/requisitions`, `/reports/purchasing/on-time`, `/reports/purchasing/open-orders` | 5 (1382 lines) |
| `pricing` | `pricing` | `/sales/price-lists`, `/sales/price-lists/:id`, `/sales/price-lists/new` | 1 (338 lines) |
| `eco` | `eco` | `/integration` | 1 (372 lines) |
| `admin` | — | `/access`, `/apps`, `/audit`, `/settings`, `/system/health` | 4 (1318 lines) |
