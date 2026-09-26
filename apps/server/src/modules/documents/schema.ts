import type { Migration } from '../../kernel/modules.js';

export const DOC_KINDS = ['sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const KIND_INFO: Record<
  DocKind,
  { side: 'sales' | 'purchases'; /** +1 increases what the party owes us, -1 decreases it */ sign: 1 | -1; seq: string; prefix: string }
> = {
  sales_invoice: { side: 'sales', sign: 1, seq: 'sales_invoice', prefix: 'INV-' },
  sales_credit: { side: 'sales', sign: -1, seq: 'sales_credit', prefix: 'CN-' },
  purchase_bill: { side: 'purchases', sign: -1, seq: 'purchase_bill', prefix: 'BILL-' },
  purchase_credit: { side: 'purchases', sign: 1, seq: 'purchase_credit', prefix: 'DN-' },
};

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
];
