import type { Migration } from '../../kernel/modules.js';

export const STOCK_DOC_KINDS = ['adjustment', 'opening', 'count', 'transfer'] as const;
export type StockDocKind = (typeof STOCK_DOC_KINDS)[number];

export const STOCK_SEQ: Record<StockDocKind, [string, string]> = {
  adjustment: ['stock_adjustment', 'ADJ-'],
  opening: ['stock_opening', 'OPN-'],
  count: ['stock_count', 'CNT-'],
  transfer: ['stock_transfer', 'TRF-'],
};

export const migrations: Migration[] = [
  {
    id: '001_inventory',
    up: `
      CREATE TABLE warehouses (
        id         INTEGER PRIMARY KEY,
        code       TEXT NOT NULL UNIQUE,
        name_en    TEXT NOT NULL,
        name_ar    TEXT NOT NULL,
        address    TEXT,
        is_active  INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO warehouses (code, name_en, name_ar, is_default, created_at)
      VALUES ('MAIN', 'Main warehouse', 'المخزن الرئيسي', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      -- Quantity on hand per item per warehouse. Stock can never go negative.
      CREATE TABLE stock_levels (
        item_id      INTEGER NOT NULL REFERENCES items(id),
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        qty          INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),       -- x1000
        PRIMARY KEY (item_id, warehouse_id)
      );

      -- Company-wide cost pool per item (moving weighted average): avg cost = value / qty.
      CREATE TABLE stock_values (
        item_id INTEGER PRIMARY KEY REFERENCES items(id),
        qty     INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
        value   INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
        CHECK (qty > 0 OR value = 0)                                     -- nothing left => nothing valued
      );

      -- The stock ledger: every movement, immutable, with running balances for instant item cards.
      CREATE TABLE stock_moves (
        id               INTEGER PRIMARY KEY,
        date             TEXT NOT NULL,
        item_id          INTEGER NOT NULL REFERENCES items(id),
        warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id),
        qty              INTEGER NOT NULL CHECK (qty <> 0),              -- signed, x1000
        value            INTEGER NOT NULL,                                -- signed, minor units
        source_type      TEXT NOT NULL,                                   -- sales_invoice … | adjustment | opening | count | transfer
        source_id        INTEGER NOT NULL,
        source_line_id   INTEGER,
        is_reversal      INTEGER NOT NULL DEFAULT 0,
        qty_after        INTEGER NOT NULL,                                -- item total after this move
        value_after      INTEGER NOT NULL,
        wh_qty_after     INTEGER NOT NULL,                                -- this warehouse after this move
        journal_entry_id INTEGER REFERENCES journal_entries(id),
        created_by       INTEGER REFERENCES users(id),
        created_at       TEXT NOT NULL
      );
      CREATE INDEX stock_moves_item ON stock_moves(item_id, id);
      CREATE INDEX stock_moves_wh ON stock_moves(warehouse_id, item_id);
      CREATE INDEX stock_moves_source ON stock_moves(source_type, source_id);
      CREATE INDEX stock_moves_date ON stock_moves(date);

      CREATE TRIGGER stock_moves_immutable BEFORE UPDATE ON stock_moves
      WHEN NOT (OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
                AND NEW.qty = OLD.qty AND NEW.value = OLD.value AND NEW.item_id = OLD.item_id
                AND NEW.warehouse_id = OLD.warehouse_id AND NEW.date = OLD.date)
      BEGIN SELECT RAISE(ABORT, 'inventory: stock movements are immutable'); END;
      CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves
      BEGIN SELECT RAISE(ABORT, 'inventory: stock movements are immutable'); END;

      -- Inventory's own documents: adjustments, opening stock, physical counts, transfers.
      CREATE TABLE stock_docs (
        id                 INTEGER PRIMARY KEY,
        kind               TEXT NOT NULL CHECK (kind IN ('adjustment', 'opening', 'count', 'transfer')),
        number             TEXT UNIQUE,
        date               TEXT NOT NULL,
        warehouse_id       INTEGER NOT NULL REFERENCES warehouses(id),
        to_warehouse_id    INTEGER REFERENCES warehouses(id),
        counter_account_id INTEGER REFERENCES accounts(id),
        reference          TEXT,
        memo               TEXT,
        status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
        journal_entry_id   INTEGER REFERENCES journal_entries(id),
        void_entry_id      INTEGER REFERENCES journal_entries(id),
        created_by         INTEGER REFERENCES users(id),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        posted_at          TEXT,
        voided_at          TEXT,
        CHECK (kind <> 'transfer' OR (to_warehouse_id IS NOT NULL AND to_warehouse_id <> warehouse_id))
      );
      CREATE INDEX stock_docs_kind ON stock_docs(kind, status, date);

      CREATE TABLE stock_doc_lines (
        id         INTEGER PRIMARY KEY,
        doc_id     INTEGER NOT NULL REFERENCES stock_docs(id) ON DELETE CASCADE,
        line_no    INTEGER NOT NULL,
        item_id    INTEGER NOT NULL REFERENCES items(id),
        qty        INTEGER NOT NULL,       -- adjustment: signed change; opening/transfer: quantity; count: counted quantity
        unit_cost  INTEGER,                -- for increases; NULL = current average cost
        system_qty INTEGER,                -- count: book quantity frozen at posting
        note       TEXT
      );
      CREATE INDEX stock_doc_lines_doc ON stock_doc_lines(doc_id);

      CREATE TRIGGER stock_docs_frozen BEFORE UPDATE ON stock_docs
      WHEN OLD.status <> 'draft' AND (
           NEW.date IS NOT OLD.date OR NEW.warehouse_id IS NOT OLD.warehouse_id OR NEW.number IS NOT OLD.number
        OR NEW.to_warehouse_id IS NOT OLD.to_warehouse_id OR NEW.kind IS NOT OLD.kind OR OLD.status = 'void')
      BEGIN SELECT RAISE(ABORT, 'inventory: posted stock documents are frozen'); END;
      CREATE TRIGGER stock_docs_no_delete BEFORE DELETE ON stock_docs
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'inventory: posted stock documents cannot be deleted'); END;
      CREATE TRIGGER stock_doc_lines_frozen_upd BEFORE UPDATE ON stock_doc_lines
      WHEN (SELECT status FROM stock_docs WHERE id = OLD.doc_id) <> 'draft'
        AND NOT (NEW.system_qty IS NOT OLD.system_qty AND NEW.qty = OLD.qty AND NEW.item_id = OLD.item_id)
      BEGIN SELECT RAISE(ABORT, 'inventory: posted stock documents are frozen'); END;
      CREATE TRIGGER stock_doc_lines_frozen_del BEFORE DELETE ON stock_doc_lines
      WHEN (SELECT status FROM stock_docs WHERE id = OLD.doc_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'inventory: posted stock documents are frozen'); END;
    `,
  },
];

migrations.push({
  id: '002_lots_receipts_landed',
  up: `
    -- ===== Lots & serial numbers =====
    CREATE TABLE stock_lots (
      id          INTEGER PRIMARY KEY,
      item_id     INTEGER NOT NULL REFERENCES items(id),
      lot_no      TEXT NOT NULL,              -- batch number, or the serial number for serial items
      expiry_date TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE (item_id, lot_no)
    );
    CREATE INDEX stock_lots_expiry ON stock_lots(expiry_date);
    CREATE INDEX stock_lots_no ON stock_lots(lot_no);

    CREATE TABLE lot_levels (
      lot_id       INTEGER NOT NULL REFERENCES stock_lots(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      qty          INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
      PRIMARY KEY (lot_id, warehouse_id)
    );

    -- ===== Stock ledger v2: lot per move, and value-only moves (landed costs, revaluations) =====
    CREATE TABLE stock_moves_v2 (
      id               INTEGER PRIMARY KEY,
      date             TEXT NOT NULL,
      item_id          INTEGER NOT NULL REFERENCES items(id),
      warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id),
      lot_id           INTEGER REFERENCES stock_lots(id),
      qty              INTEGER NOT NULL,
      value            INTEGER NOT NULL,
      source_type      TEXT NOT NULL,
      source_id        INTEGER NOT NULL,
      source_line_id   INTEGER,
      is_reversal      INTEGER NOT NULL DEFAULT 0,
      qty_after        INTEGER NOT NULL,
      value_after      INTEGER NOT NULL,
      wh_qty_after     INTEGER NOT NULL,
      journal_entry_id INTEGER REFERENCES journal_entries(id),
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT NOT NULL,
      CHECK (qty <> 0 OR value <> 0)
    );
    INSERT INTO stock_moves_v2 (id, date, item_id, warehouse_id, qty, value, source_type, source_id, source_line_id, is_reversal,
                                qty_after, value_after, wh_qty_after, journal_entry_id, created_by, created_at)
    SELECT id, date, item_id, warehouse_id, qty, value, source_type, source_id, source_line_id, is_reversal,
           qty_after, value_after, wh_qty_after, journal_entry_id, created_by, created_at FROM stock_moves;
    DROP TABLE stock_moves;
    ALTER TABLE stock_moves_v2 RENAME TO stock_moves;
    CREATE INDEX stock_moves_item ON stock_moves(item_id, id);
    CREATE INDEX stock_moves_wh ON stock_moves(warehouse_id, item_id, date);
    CREATE INDEX stock_moves_source ON stock_moves(source_type, source_id);
    CREATE INDEX stock_moves_date ON stock_moves(date);
    CREATE INDEX stock_moves_lot ON stock_moves(lot_id);
    CREATE TRIGGER stock_moves_immutable BEFORE UPDATE ON stock_moves
    WHEN NOT (OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
              AND NEW.qty = OLD.qty AND NEW.value = OLD.value AND NEW.item_id = OLD.item_id
              AND NEW.warehouse_id = OLD.warehouse_id AND NEW.date = OLD.date AND NEW.lot_id IS OLD.lot_id)
    BEGIN SELECT RAISE(ABORT, 'inventory: stock movements are immutable'); END;
    CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves
    BEGIN SELECT RAISE(ABORT, 'inventory: stock movements are immutable'); END;

    -- ===== Units & lots on stock documents =====
    ALTER TABLE stock_doc_lines ADD COLUMN unit_id INTEGER REFERENCES item_units(id);
    ALTER TABLE stock_doc_lines ADD COLUMN unit_factor INTEGER NOT NULL DEFAULT 1000;
    ALTER TABLE stock_doc_lines ADD COLUMN lots TEXT;          -- JSON [{lotNo, expiry, qty}] (qty in the line unit)

    -- ===== Goods receipt notes (goods arrive before the supplier's invoice) =====
    CREATE TABLE goods_receipts (
      id               INTEGER PRIMARY KEY,
      number           TEXT UNIQUE,
      supplier_id      INTEGER NOT NULL REFERENCES parties(id),
      po_id            INTEGER,                                 -- purchase order (purchasing module), if any
      date             TEXT NOT NULL,
      warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id),
      reference        TEXT,                                    -- supplier's delivery note number
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
    CREATE INDEX goods_receipts_supplier ON goods_receipts(supplier_id, status);
    CREATE INDEX goods_receipts_po ON goods_receipts(po_id);

    CREATE TABLE goods_receipt_lines (
      id            INTEGER PRIMARY KEY,
      receipt_id    INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      line_no       INTEGER NOT NULL,
      item_id       INTEGER NOT NULL REFERENCES items(id),
      description   TEXT,
      unit_id       INTEGER REFERENCES item_units(id),
      unit_factor   INTEGER NOT NULL DEFAULT 1000,
      quantity      INTEGER NOT NULL CHECK (quantity > 0),     -- in the line unit, x1000
      base_quantity INTEGER NOT NULL CHECK (base_quantity > 0),
      unit_cost     INTEGER NOT NULL CHECK (unit_cost >= 0),   -- per line unit
      value         INTEGER NOT NULL,
      po_line_id    INTEGER,
      lots          TEXT,
      billed_base   INTEGER NOT NULL DEFAULT 0,                -- base quantity already invoiced by the supplier
      billed_value  INTEGER NOT NULL DEFAULT 0,                -- receipt value cleared from GRNI by those invoices
      CHECK (billed_base >= 0 AND billed_base <= base_quantity)
    );
    CREATE INDEX goods_receipt_lines_receipt ON goods_receipt_lines(receipt_id);
    CREATE INDEX goods_receipt_lines_po ON goods_receipt_lines(po_line_id);

    -- Which supplier-invoice line cleared which receipt line, and how the price difference was booked.
    CREATE TABLE receipt_matches (
      document_line_id INTEGER PRIMARY KEY,
      receipt_line_id  INTEGER NOT NULL REFERENCES goods_receipt_lines(id),
      base_quantity    INTEGER NOT NULL,
      clearing         INTEGER NOT NULL,
      to_inventory     INTEGER NOT NULL,
      to_cogs          INTEGER NOT NULL
    );

    CREATE TRIGGER goods_receipts_frozen BEFORE UPDATE ON goods_receipts
    WHEN OLD.status <> 'draft' AND (
         NEW.date IS NOT OLD.date OR NEW.warehouse_id IS NOT OLD.warehouse_id OR NEW.number IS NOT OLD.number
      OR NEW.supplier_id IS NOT OLD.supplier_id OR OLD.status = 'void')
    BEGIN SELECT RAISE(ABORT, 'inventory: posted receipts are frozen'); END;
    CREATE TRIGGER goods_receipts_no_delete BEFORE DELETE ON goods_receipts
    WHEN OLD.status <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'inventory: posted receipts cannot be deleted'); END;
    CREATE TRIGGER goods_receipt_lines_frozen BEFORE UPDATE ON goods_receipt_lines
    WHEN (SELECT status FROM goods_receipts WHERE id = OLD.receipt_id) <> 'draft'
      AND (NEW.quantity IS NOT OLD.quantity OR NEW.value IS NOT OLD.value OR NEW.item_id IS NOT OLD.item_id)
    BEGIN SELECT RAISE(ABORT, 'inventory: posted receipts are frozen'); END;
    CREATE TRIGGER goods_receipt_lines_no_delete BEFORE DELETE ON goods_receipt_lines
    WHEN (SELECT status FROM goods_receipts WHERE id = OLD.receipt_id) <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'inventory: posted receipts are frozen'); END;

    -- ===== Landed costs: freight, customs, insurance spread over received goods =====
    CREATE TABLE landed_costs (
      id                 INTEGER PRIMARY KEY,
      number             TEXT UNIQUE,
      date               TEXT NOT NULL,
      counter_account_id INTEGER NOT NULL REFERENCES accounts(id),
      amount             INTEGER NOT NULL CHECK (amount > 0),
      method             TEXT NOT NULL DEFAULT 'value' CHECK (method IN ('value', 'qty')),
      reference          TEXT,
      memo               TEXT,
      status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
      journal_entry_id   INTEGER REFERENCES journal_entries(id),
      void_entry_id      INTEGER REFERENCES journal_entries(id),
      created_by         INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      posted_at          TEXT,
      voided_at          TEXT
    );
    CREATE TABLE landed_cost_targets (
      landed_cost_id INTEGER NOT NULL REFERENCES landed_costs(id) ON DELETE CASCADE,
      source_type    TEXT NOT NULL CHECK (source_type IN ('purchase_bill', 'goods_receipt')),
      source_id      INTEGER NOT NULL,
      PRIMARY KEY (landed_cost_id, source_type, source_id)
    );
    CREATE TABLE landed_cost_allocations (
      id             INTEGER PRIMARY KEY,
      landed_cost_id INTEGER NOT NULL REFERENCES landed_costs(id),
      item_id        INTEGER NOT NULL REFERENCES items(id),
      received_qty   INTEGER NOT NULL,
      received_value INTEGER NOT NULL,
      amount         INTEGER NOT NULL,
      to_inventory   INTEGER NOT NULL,
      to_cogs        INTEGER NOT NULL
    );
    CREATE TRIGGER landed_costs_no_delete BEFORE DELETE ON landed_costs
    WHEN OLD.status <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'inventory: posted landed costs cannot be deleted'); END;
  `,
});

migrations.push({
  // Goods bought in a foreign currency (a USD purchase order): the receipt keeps the order's currency and
  // the rate of the receipt date; unit_cost and value stay in the base currency (what stock and GRNI use).
  id: '003_receipt_currency',
  up: `
    ALTER TABLE goods_receipts ADD COLUMN currency TEXT;                 -- NULL = base currency
    ALTER TABLE goods_receipts ADD COLUMN exchange_rate INTEGER;         -- base units per 1 unit x 1,000,000
    ALTER TABLE goods_receipt_lines ADD COLUMN unit_cost_fx INTEGER;     -- per line unit, in the receipt currency
    ALTER TABLE goods_receipt_lines ADD COLUMN value_fx INTEGER;
  `,
});
