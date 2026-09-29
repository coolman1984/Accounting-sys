import type { Migration } from '../../kernel/modules.js';

export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

export const migrations: Migration[] = [
  {
    id: '001_purchase_orders',
    up: `
      CREATE TABLE purchase_orders (
        id            INTEGER PRIMARY KEY,
        number        TEXT UNIQUE,
        supplier_id   INTEGER NOT NULL REFERENCES parties(id),
        date          TEXT NOT NULL,
        expected_date TEXT,
        warehouse_id  INTEGER REFERENCES warehouses(id),
        reference     TEXT,
        notes         TEXT,
        status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
        subtotal      INTEGER NOT NULL DEFAULT 0,
        tax_total     INTEGER NOT NULL DEFAULT 0,
        total         INTEGER NOT NULL DEFAULT 0,
        created_by    INTEGER REFERENCES users(id),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        approved_by   INTEGER REFERENCES users(id),
        approved_at   TEXT,
        closed_at     TEXT
      );
      CREATE INDEX purchase_orders_supplier ON purchase_orders(supplier_id, status);

      CREATE TABLE purchase_order_lines (
        id            INTEGER PRIMARY KEY,
        po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        line_no       INTEGER NOT NULL,
        item_id       INTEGER REFERENCES items(id),
        description   TEXT NOT NULL,
        unit_id       INTEGER REFERENCES item_units(id),
        unit_factor   INTEGER NOT NULL DEFAULT 1000,
        quantity      INTEGER NOT NULL CHECK (quantity > 0),
        base_quantity INTEGER NOT NULL,
        unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
        discount_bp   INTEGER NOT NULL DEFAULT 0,
        tax_id        INTEGER REFERENCES taxes(id),
        tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
        net           INTEGER NOT NULL,
        tax           INTEGER NOT NULL,
        total         INTEGER NOT NULL,
        received_base INTEGER NOT NULL DEFAULT 0,   -- base units received (goods receipts, or bills without a receipt)
        billed_base   INTEGER NOT NULL DEFAULT 0    -- base units invoiced by the supplier
      );
      CREATE INDEX purchase_order_lines_po ON purchase_order_lines(po_id);

      CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'purchasing: approved orders cannot be deleted'); END;
    `,
  },
  {
    // Imports (USD orders, ~70 days by sea): order currency, trade terms, ports, a date per line,
    // purchase requisitions (manual or from manufacturing's MRP) and letters of credit.
    id: '002_imports_requisitions_lc',
    up: `
      ALTER TABLE purchase_orders ADD COLUMN currency TEXT;                -- NULL = base currency
      ALTER TABLE purchase_orders ADD COLUMN exchange_rate INTEGER;        -- indicative, at the order date (x 1,000,000)
      ALTER TABLE purchase_orders ADD COLUMN incoterm TEXT CHECK (incoterm IS NULL OR incoterm IN ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'));
      ALTER TABLE purchase_orders ADD COLUMN port_of_loading TEXT;
      ALTER TABLE purchase_orders ADD COLUMN port_of_discharge TEXT;
      ALTER TABLE purchase_order_lines ADD COLUMN expected_date TEXT;      -- NULL = the order's expected date
      ALTER TABLE purchase_order_lines ADD COLUMN requisition_id INTEGER;  -- purchase_requisitions(id)

      CREATE TABLE purchase_requisitions (
        id             INTEGER PRIMARY KEY,
        number         TEXT NOT NULL UNIQUE,
        source         TEXT NOT NULL CHECK (source IN ('manual', 'mrp')),
        item_id        INTEGER NOT NULL REFERENCES items(id),
        quantity       INTEGER NOT NULL CHECK (quantity > 0),          -- base units x1000
        need_date      TEXT NOT NULL,
        order_by_date  TEXT,
        warehouse_id   INTEGER REFERENCES warehouses(id),
        supplier_id    INTEGER REFERENCES parties(id),                 -- suggested (the item's usual supplier)
        status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'closed', 'cancelled')),
        pegging        TEXT,                                           -- what the quantity serves, one line per demand
        notes          TEXT,
        global_id      TEXT UNIQUE,                                    -- mes.purchase_requisition.v1 id (from GMES)
        global_code    TEXT,
        global_version INTEGER,
        mrp_run        TEXT,
        po_id          INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX purchase_requisitions_status ON purchase_requisitions(status, need_date);
      CREATE INDEX purchase_order_lines_req ON purchase_order_lines(requisition_id) WHERE requisition_id IS NOT NULL;

      -- Letters of credit (optional per order: Egypt dropped the mandatory LC in December 2022).
      CREATE TABLE letters_of_credit (
        id                   INTEGER PRIMARY KEY,
        number               TEXT NOT NULL UNIQUE,                     -- Mizan's LOC-00001
        lc_number            TEXT NOT NULL,                            -- the bank's reference
        supplier_id          INTEGER NOT NULL REFERENCES parties(id),
        po_id                INTEGER REFERENCES purchase_orders(id),
        bank_account_id      INTEGER NOT NULL REFERENCES accounts(id),
        currency             TEXT NOT NULL,
        amount               INTEGER NOT NULL CHECK (amount > 0),       -- LC currency, minor units
        margin_bp            INTEGER NOT NULL DEFAULT 0 CHECK (margin_bp BETWEEN 0 AND 10000),
        margin_amount        INTEGER NOT NULL DEFAULT 0,               -- LC currency
        margin_base          INTEGER NOT NULL DEFAULT 0,               -- base currency, booked at opening
        margin_used_base     INTEGER NOT NULL DEFAULT 0,
        opening_rate         INTEGER NOT NULL,
        margin_account_id    INTEGER NOT NULL REFERENCES accounts(id),
        financing_account_id INTEGER NOT NULL REFERENCES accounts(id),
        charges_account_id   INTEGER NOT NULL REFERENCES accounts(id),
        opening_date         TEXT NOT NULL,
        expiry_date          TEXT NOT NULL,
        latest_shipment_date TEXT,
        status               TEXT NOT NULL DEFAULT 'opened' CHECK (status IN ('opened', 'documents_received', 'settled', 'cancelled')),
        settled_amount       INTEGER NOT NULL DEFAULT 0,               -- LC currency
        financed_base        INTEGER NOT NULL DEFAULT 0,               -- bank financing booked
        repaid_base          INTEGER NOT NULL DEFAULT 0,
        margin_entry_id      INTEGER REFERENCES journal_entries(id),
        documents_date       TEXT,
        notes                TEXT,
        created_by           INTEGER REFERENCES users(id),
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        CHECK (expiry_date >= opening_date),
        CHECK (settled_amount >= 0 AND settled_amount <= amount)
      );
      CREATE INDEX letters_of_credit_po ON letters_of_credit(po_id);

      CREATE TABLE lc_events (
        id          INTEGER PRIMARY KEY,
        lc_id       INTEGER NOT NULL REFERENCES letters_of_credit(id),
        kind        TEXT NOT NULL CHECK (kind IN ('margin', 'charges', 'documents', 'settlement', 'repayment', 'release', 'cancel')),
        date        TEXT NOT NULL,
        amount      INTEGER NOT NULL DEFAULT 0,                        -- LC currency (settlement) or base (charges, repayment)
        base_amount INTEGER NOT NULL DEFAULT 0,
        rate        INTEGER,
        document_id INTEGER REFERENCES documents(id),
        entry_id    INTEGER REFERENCES journal_entries(id),
        memo        TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT NOT NULL
      );
      CREATE INDEX lc_events_lc ON lc_events(lc_id);
      CREATE TRIGGER lc_events_immutable BEFORE UPDATE ON lc_events
      BEGIN SELECT RAISE(ABORT, 'purchasing: letter of credit history is immutable'); END;
      CREATE TRIGGER lc_events_no_delete BEFORE DELETE ON lc_events
      BEGIN SELECT RAISE(ABORT, 'purchasing: letter of credit history is immutable'); END;
    `,
  },
];
