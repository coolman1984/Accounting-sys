import type { Migration } from '../../kernel/modules.js';

export const SO_STATUSES = ['draft', 'confirmed', 'partially_delivered', 'closed', 'cancelled'] as const;

export const migrations: Migration[] = [
  {
    id: '001_sales_orders',
    up: `
      -- Sales order (SAP SD VA01): what the customer ordered, at what price and by when.
      CREATE TABLE sales_orders (
        id                 INTEGER PRIMARY KEY,
        number             TEXT UNIQUE,                          -- SO-00001, assigned when confirmed
        customer_id        INTEGER NOT NULL REFERENCES parties(id),
        order_date         TEXT NOT NULL,
        customer_reference TEXT,                                 -- the customer's PO number
        ship_to            TEXT,
        currency           TEXT NOT NULL,
        exchange_rate      INTEGER NOT NULL DEFAULT 1000000 CHECK (exchange_rate > 0),
        price_list_id      INTEGER,                              -- the customer's list when the order was written
        priority           INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
        payment_terms_days INTEGER NOT NULL DEFAULT 0,
        warehouse_id       INTEGER,
        status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'partially_delivered', 'closed', 'cancelled')),
        short_closed       INTEGER NOT NULL DEFAULT 0,           -- closed by hand with quantities left undelivered
        notes              TEXT,
        subtotal           INTEGER NOT NULL DEFAULT 0,
        discount_total     INTEGER NOT NULL DEFAULT 0,
        tax_total          INTEGER NOT NULL DEFAULT 0,
        total              INTEGER NOT NULL DEFAULT 0,
        base_total         INTEGER NOT NULL DEFAULT 0,
        credit_override_by INTEGER REFERENCES users(id),
        created_by         INTEGER REFERENCES users(id),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        confirmed_by       INTEGER REFERENCES users(id),
        confirmed_at       TEXT,
        closed_at          TEXT
      );
      CREATE INDEX sales_orders_customer ON sales_orders(customer_id, status);
      CREATE INDEX sales_orders_status ON sales_orders(status, order_date);

      CREATE TABLE sales_order_lines (
        id             INTEGER PRIMARY KEY,
        so_id          INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
        line_no        INTEGER NOT NULL,
        item_id        INTEGER NOT NULL REFERENCES items(id),
        description    TEXT NOT NULL,
        quantity       INTEGER NOT NULL CHECK (quantity > 0),         -- base unit × 1000
        unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),      -- order currency, per base unit
        price_source   TEXT NOT NULL DEFAULT 'manual' CHECK (price_source IN ('list', 'item', 'manual')),
        discount_bp    INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
        tax_id         INTEGER REFERENCES taxes(id),
        tax_rate_bp    INTEGER NOT NULL DEFAULT 0,
        gross          INTEGER NOT NULL,
        discount       INTEGER NOT NULL,
        net            INTEGER NOT NULL,
        tax            INTEGER NOT NULL,
        total          INTEGER NOT NULL,
        requested_date TEXT NOT NULL,
        promised_date  TEXT,                                          -- from ATP when confirmed (null = cannot be promised yet)
        warehouse_id   INTEGER,
        delivered_qty  INTEGER NOT NULL DEFAULT 0,
        invoiced_qty   INTEGER NOT NULL DEFAULT 0,
        cancelled_qty  INTEGER NOT NULL DEFAULT 0,                    -- what a short close gave up
        CHECK (delivered_qty >= 0 AND delivered_qty + cancelled_qty <= quantity),
        CHECK (invoiced_qty >= 0 AND invoiced_qty <= delivered_qty)
      );
      CREATE INDEX sales_order_lines_so ON sales_order_lines(so_id);
      CREATE INDEX sales_order_lines_item ON sales_order_lines(item_id);

      -- Stock promised to a confirmed line. The sum per item × warehouse never exceeds what was on hand when reserved.
      CREATE TABLE sales_reservations (
        so_line_id   INTEGER PRIMARY KEY REFERENCES sales_order_lines(id) ON DELETE CASCADE,
        item_id      INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        qty          INTEGER NOT NULL CHECK (qty > 0),
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX sales_reservations_item ON sales_reservations(item_id, warehouse_id);

      -- Outbound delivery (SAP VL01N); posting it is the goods issue (mvt 601).
      CREATE TABLE sales_deliveries (
        id               INTEGER PRIMARY KEY,
        number           TEXT UNIQUE,                            -- DLV-00001, assigned at posting
        so_id            INTEGER NOT NULL REFERENCES sales_orders(id),
        customer_id      INTEGER NOT NULL REFERENCES parties(id),
        date             TEXT NOT NULL,
        ship_to          TEXT,
        reference        TEXT,                                   -- waybill / truck, free text
        external_ref     TEXT,                                   -- idempotency key of an integration (eco:<event id>)
        notes            TEXT,
        status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
        journal_entry_id INTEGER REFERENCES journal_entries(id),
        void_entry_id    INTEGER REFERENCES journal_entries(id),
        created_by       INTEGER REFERENCES users(id),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        posted_at        TEXT,
        voided_at        TEXT
      );
      CREATE UNIQUE INDEX sales_deliveries_external ON sales_deliveries(external_ref) WHERE external_ref IS NOT NULL;
      CREATE INDEX sales_deliveries_so ON sales_deliveries(so_id);

      CREATE TABLE sales_delivery_lines (
        id           INTEGER PRIMARY KEY,
        delivery_id  INTEGER NOT NULL REFERENCES sales_deliveries(id) ON DELETE CASCADE,
        line_no      INTEGER NOT NULL,
        so_line_id   INTEGER NOT NULL REFERENCES sales_order_lines(id),
        item_id      INTEGER NOT NULL REFERENCES items(id),
        warehouse_id INTEGER,
        qty          INTEGER NOT NULL CHECK (qty > 0),                -- base unit × 1000
        lots         TEXT,
        cost         INTEGER NOT NULL DEFAULT 0,                      -- what left stock at posting (base currency)
        invoiced_qty INTEGER NOT NULL DEFAULT 0,
        CHECK (invoiced_qty >= 0 AND invoiced_qty <= qty)
      );
      CREATE INDEX sales_delivery_lines_delivery ON sales_delivery_lines(delivery_id);
      CREATE INDEX sales_delivery_lines_so_line ON sales_delivery_lines(so_line_id);

      -- Planned supply by date (finished goods from production), filled by the manufacturing integration.
      CREATE TABLE sales_supply_plan (
        id         INTEGER PRIMARY KEY,
        item_id    INTEGER NOT NULL REFERENCES items(id),
        date       TEXT NOT NULL,
        qty        INTEGER NOT NULL CHECK (qty > 0),
        source     TEXT NOT NULL DEFAULT 'manual',
        reference  TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (item_id, date, source)
      );

      CREATE TRIGGER sales_orders_no_delete BEFORE DELETE ON sales_orders
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sales: confirmed orders cannot be deleted'); END;

      CREATE TRIGGER sales_deliveries_no_delete BEFORE DELETE ON sales_deliveries
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sales: posted deliveries cannot be deleted'); END;

      CREATE TRIGGER sales_delivery_lines_frozen BEFORE UPDATE OF qty, so_line_id, item_id, warehouse_id, cost ON sales_delivery_lines
      WHEN (SELECT status FROM sales_deliveries WHERE id = OLD.delivery_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sales: posted deliveries are frozen'); END;
    `,
  },
];
