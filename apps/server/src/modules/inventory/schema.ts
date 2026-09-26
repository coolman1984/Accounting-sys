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
