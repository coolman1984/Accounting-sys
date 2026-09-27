import type { Migration } from '../../kernel/modules.js';

export { DOC_KINDS, KIND_INFO, type DocKind } from '../../contracts/documents.js';

export const migrations: Migration[] = [
  {
    id: '001_documents',
    up: `
      CREATE TABLE documents (
        id                  INTEGER PRIMARY KEY,
        kind                TEXT NOT NULL CHECK (kind IN ('sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit')),
        number              TEXT,                                  -- assigned at posting, gap-free per kind
        party_id            INTEGER NOT NULL REFERENCES parties(id),
        date                TEXT NOT NULL,
        due_date            TEXT NOT NULL,
        reference           TEXT,                                  -- customer PO / supplier's invoice number
        notes               TEXT,
        currency            TEXT NOT NULL,
        tax_inclusive       INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
        subtotal            INTEGER NOT NULL DEFAULT 0,            -- sum of net lines (after discount, before tax)
        discount_total      INTEGER NOT NULL DEFAULT 0,
        tax_total           INTEGER NOT NULL DEFAULT 0,
        total               INTEGER NOT NULL DEFAULT 0,
        amount_settled      INTEGER NOT NULL DEFAULT 0,            -- paid / credited so far
        against_document_id INTEGER REFERENCES documents(id),      -- credit note -> original invoice
        journal_entry_id    INTEGER REFERENCES journal_entries(id),
        void_entry_id       INTEGER REFERENCES journal_entries(id),
        created_by          INTEGER REFERENCES users(id),
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        posted_at           TEXT,
        voided_at           TEXT,
        UNIQUE (kind, number),
        CHECK (amount_settled >= 0 AND amount_settled <= total),
        CHECK (due_date >= date)
      );
      CREATE INDEX documents_kind ON documents(kind, status, date);
      CREATE INDEX documents_party ON documents(party_id, kind, status);

      CREATE TABLE document_lines (
        id          INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        line_no     INTEGER NOT NULL,
        item_id     INTEGER REFERENCES items(id),
        description TEXT NOT NULL,
        quantity    INTEGER NOT NULL CHECK (quantity > 0),         -- x1000
        unit_price  INTEGER NOT NULL CHECK (unit_price >= 0),      -- minor units
        discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
        account_id  INTEGER NOT NULL REFERENCES accounts(id),
        tax_id      INTEGER REFERENCES taxes(id),
        tax_rate_bp INTEGER NOT NULL DEFAULT 0,                    -- snapshot of the rate used
        gross       INTEGER NOT NULL,
        discount    INTEGER NOT NULL,
        net         INTEGER NOT NULL,
        tax         INTEGER NOT NULL,
        total       INTEGER NOT NULL
      );
      CREATE INDEX document_lines_doc ON document_lines(document_id);

      -- How an invoice/bill got paid: by a payment, or by a credit note.
      CREATE TABLE settlements (
        id          INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        source_type TEXT NOT NULL CHECK (source_type IN ('payment', 'credit')),
        source_id   INTEGER NOT NULL,
        source_number TEXT,                                          -- e.g. RCT-00012 / CN-00003, for display
        amount      INTEGER NOT NULL CHECK (amount > 0),
        date        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX settlements_doc ON settlements(document_id);
      CREATE INDEX settlements_source ON settlements(source_type, source_id);

      -- Posted documents are frozen (only settlement progress and voiding may change).
      CREATE TRIGGER documents_posted_frozen BEFORE UPDATE ON documents
      WHEN OLD.status <> 'draft' AND (
           NEW.party_id IS NOT OLD.party_id OR NEW.date IS NOT OLD.date OR NEW.total IS NOT OLD.total
        OR NEW.number IS NOT OLD.number OR NEW.kind IS NOT OLD.kind OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
        OR (OLD.status = 'void'))
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;

      CREATE TRIGGER documents_posted_no_delete BEFORE DELETE ON documents
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents cannot be deleted'); END;

      CREATE TRIGGER document_lines_frozen_upd BEFORE UPDATE ON document_lines
      WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;

      CREATE TRIGGER document_lines_frozen_del BEFORE DELETE ON document_lines
      WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;

      CREATE TRIGGER document_lines_frozen_ins BEFORE INSERT ON document_lines
      WHEN (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;
    `,
  },
  {
    // Where goods come from / go to. Validated by the inventory module when it is installed.
    id: '002_warehouses',
    up: `
      ALTER TABLE documents ADD COLUMN warehouse_id INTEGER;
      ALTER TABLE document_lines ADD COLUMN warehouse_id INTEGER;

      DROP TRIGGER documents_posted_frozen;
      CREATE TRIGGER documents_posted_frozen BEFORE UPDATE ON documents
      WHEN OLD.status <> 'draft' AND (
           NEW.party_id IS NOT OLD.party_id OR NEW.date IS NOT OLD.date OR NEW.total IS NOT OLD.total
        OR NEW.number IS NOT OLD.number OR NEW.kind IS NOT OLD.kind OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
        OR NEW.warehouse_id IS NOT OLD.warehouse_id OR (OLD.status = 'void'))
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;
    `,
  },
  {
    id: '003_units_ext',
    up: `
      ALTER TABLE document_lines ADD COLUMN unit_id INTEGER REFERENCES item_units(id);
      ALTER TABLE document_lines ADD COLUMN unit_factor INTEGER NOT NULL DEFAULT 1000;
      ALTER TABLE document_lines ADD COLUMN base_quantity INTEGER;          -- x1000, in the item's base unit
      ALTER TABLE document_lines ADD COLUMN ext TEXT;                       -- JSON extension data (lots, links)

      -- Back-fill existing lines (the freeze trigger is lifted only for this one-off, same transaction).
      DROP TRIGGER document_lines_frozen_upd;
      UPDATE document_lines SET base_quantity = quantity;
      CREATE TRIGGER document_lines_frozen_upd BEFORE UPDATE ON document_lines
      WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;
    `,
  },
  {
    // Cost center (CO) per line: revenue and expense lines carry it into the ledger.
    id: '004_cost_center',
    up: `ALTER TABLE document_lines ADD COLUMN cost_center_id INTEGER;`,
  },
  {
    // Multi-currency: amounts stay in the document currency (what is printed); the base-currency
    // figures are computed once from the rate and are what the books, stock and reports use.
    id: '005_currency',
    up: `
      ALTER TABLE documents ADD COLUMN exchange_rate INTEGER NOT NULL DEFAULT 1000000 CHECK (exchange_rate > 0);
      ALTER TABLE documents ADD COLUMN base_subtotal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN base_tax_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN base_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN base_settled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE document_lines ADD COLUMN base_net INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE document_lines ADD COLUMN base_tax INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE settlements ADD COLUMN base_amount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE settlements ADD COLUMN source_base_amount INTEGER NOT NULL DEFAULT 0;

      DROP TRIGGER documents_posted_frozen;
      DROP TRIGGER document_lines_frozen_upd;
      UPDATE documents SET base_subtotal = subtotal, base_tax_total = tax_total, base_total = total, base_settled = amount_settled;
      UPDATE document_lines SET base_net = net, base_tax = tax;
      UPDATE settlements SET base_amount = amount, source_base_amount = amount;
      CREATE TRIGGER documents_posted_frozen BEFORE UPDATE ON documents
      WHEN OLD.status <> 'draft' AND (
           NEW.party_id IS NOT OLD.party_id OR NEW.date IS NOT OLD.date OR NEW.total IS NOT OLD.total
        OR NEW.number IS NOT OLD.number OR NEW.kind IS NOT OLD.kind OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
        OR NEW.currency IS NOT OLD.currency OR NEW.exchange_rate IS NOT OLD.exchange_rate OR NEW.base_total IS NOT OLD.base_total
        OR (OLD.status = 'void'))
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;
      CREATE TRIGGER document_lines_frozen_upd BEFORE UPDATE ON document_lines
      WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'documents: posted documents are frozen'); END;
    `,
  },
  {
    // Cheques (post-dated cheques app) settle invoices and bills too: widen the source types.
    id: '006_cheque_settlements',
    up: `
      CREATE TABLE settlements_new (
        id                 INTEGER PRIMARY KEY,
        document_id        INTEGER NOT NULL REFERENCES documents(id),
        source_type        TEXT NOT NULL CHECK (source_type IN ('payment', 'credit', 'cheque')),
        source_id          INTEGER NOT NULL,
        source_number      TEXT,
        amount             INTEGER NOT NULL CHECK (amount > 0),
        date               TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        base_amount        INTEGER NOT NULL DEFAULT 0,
        source_base_amount INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO settlements_new (id, document_id, source_type, source_id, source_number, amount, date, created_at, base_amount, source_base_amount)
        SELECT id, document_id, source_type, source_id, source_number, amount, date, created_at, base_amount, source_base_amount FROM settlements;
      DROP TABLE settlements;
      ALTER TABLE settlements_new RENAME TO settlements;
      CREATE INDEX settlements_doc ON settlements(document_id);
      CREATE INDEX settlements_source ON settlements(source_type, source_id);
    `,
  },
];
