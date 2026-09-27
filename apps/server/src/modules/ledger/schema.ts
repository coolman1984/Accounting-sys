import type { Migration } from '../../kernel/modules.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Subtypes drive the financial statements (current vs non-current, COGS vs
 * operating expense, cash-flow classification) and business rules (AR/AP
 * lines need a party, payments go through cash/bank accounts).
 */
export const SUBTYPES: Record<AccountType, readonly string[]> = {
  asset: ['cash', 'bank', 'marketable_securities', 'receivable', 'inventory', 'current_asset', 'fixed_asset', 'accumulated_depreciation', 'non_current_asset'],
  // short_term_debt: interest-bearing borrowings due within a year (analysis needs them apart from trade payables).
  liability: ['payable', 'short_term_debt', 'current_liability', 'non_current_liability'],
  // dividends: dividends declared / owner's drawings — reduce equity, never an expense.
  equity: ['equity', 'retained_earnings', 'dividends'],
  income: ['operating_income', 'other_income'],
  // interest_expense and income_tax are kept apart so statements show EBIT, profit before tax and tax.
  expense: ['cogs', 'operating_expense', 'depreciation', 'other_expense', 'interest_expense', 'income_tax'],
};

/** Debit-normal types; the others are credit-normal. */
export const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(['asset', 'expense']);

export const migrations: Migration[] = [
  {
    id: '001_ledger',
    up: `
      CREATE TABLE accounts (
        id          INTEGER PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE,
        name_en     TEXT NOT NULL,
        name_ar     TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
        subtype     TEXT NOT NULL,
        parent_id   INTEGER REFERENCES accounts(id),
        is_group    INTEGER NOT NULL DEFAULT 0,   -- group (header) accounts only aggregate, never receive postings
        is_active   INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX accounts_parent ON accounts(parent_id);

      CREATE TABLE journal_entries (
        id             INTEGER PRIMARY KEY,
        number         TEXT UNIQUE,                -- assigned at posting, gap-free
        date           TEXT NOT NULL,
        reference      TEXT,
        memo           TEXT,
        source_type    TEXT NOT NULL DEFAULT 'manual',
        source_id      INTEGER,
        status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
        total          INTEGER NOT NULL DEFAULT 0,
        reversal_of_id INTEGER REFERENCES journal_entries(id),
        reversed_by_id INTEGER REFERENCES journal_entries(id),
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        posted_by      INTEGER REFERENCES users(id),
        posted_at      TEXT
      );
      CREATE INDEX je_status_date ON journal_entries(status, date);
      CREATE INDEX je_source ON journal_entries(source_type, source_id);

      CREATE TABLE journal_lines (
        id          INTEGER PRIMARY KEY,
        entry_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        line_no     INTEGER NOT NULL,
        account_id  INTEGER NOT NULL REFERENCES accounts(id),
        party_id    INTEGER,                      -- sub-ledger dimension (customer / supplier)
        description TEXT,
        debit       INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit      INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
        CHECK ((debit = 0) <> (credit = 0))       -- exactly one side per line
      );
      CREATE INDEX jl_entry ON journal_lines(entry_id);
      CREATE INDEX jl_account ON journal_lines(account_id);
      CREATE INDEX jl_party ON journal_lines(party_id);

      CREATE TABLE fiscal_years (
        id               INTEGER PRIMARY KEY,
        name             TEXT NOT NULL,
        start_date       TEXT NOT NULL,
        end_date         TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        closing_entry_id INTEGER REFERENCES journal_entries(id),
        closed_at        TEXT,
        closed_by        INTEGER REFERENCES users(id),
        CHECK (end_date >= start_date)
      );

      -- ===== Ledger integrity, enforced by the database itself =====

      -- A posted entry can never be edited; the only allowed change is linking its reversal once.
      CREATE TRIGGER je_posted_immutable BEFORE UPDATE ON journal_entries
      WHEN OLD.status = 'posted' AND (
           NEW.status IS NOT OLD.status OR NEW.date IS NOT OLD.date OR NEW.number IS NOT OLD.number
        OR NEW.total IS NOT OLD.total OR NEW.reference IS NOT OLD.reference OR NEW.memo IS NOT OLD.memo
        OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id
        OR NEW.reversal_of_id IS NOT OLD.reversal_of_id
        OR (OLD.reversed_by_id IS NOT NULL AND NEW.reversed_by_id IS NOT OLD.reversed_by_id))
      BEGIN SELECT RAISE(ABORT, 'ledger: posted journal entries are immutable'); END;

      CREATE TRIGGER je_posted_no_delete BEFORE DELETE ON journal_entries
      WHEN OLD.status = 'posted'
      BEGIN SELECT RAISE(ABORT, 'ledger: posted journal entries cannot be deleted'); END;

      -- Posting requires a balanced entry with at least two lines.
      CREATE TRIGGER je_post_balanced BEFORE UPDATE OF status ON journal_entries
      WHEN NEW.status = 'posted' AND OLD.status = 'draft' AND (
           (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
        OR (SELECT SUM(debit) - SUM(credit) FROM journal_lines WHERE entry_id = NEW.id) <> 0
        OR (SELECT SUM(debit) FROM journal_lines WHERE entry_id = NEW.id) <> NEW.total)
      BEGIN SELECT RAISE(ABORT, 'ledger: entry is not balanced'); END;

      CREATE TRIGGER jl_posted_no_insert BEFORE INSERT ON journal_lines
      WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'posted'
      BEGIN SELECT RAISE(ABORT, 'ledger: posted journal entries are immutable'); END;

      CREATE TRIGGER jl_posted_no_update BEFORE UPDATE ON journal_lines
      WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted'
      BEGIN SELECT RAISE(ABORT, 'ledger: posted journal entries are immutable'); END;

      CREATE TRIGGER jl_posted_no_delete BEFORE DELETE ON journal_lines
      WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted'
      BEGIN SELECT RAISE(ABORT, 'ledger: posted journal entries are immutable'); END;

      -- Group accounts only aggregate.
      CREATE TRIGGER jl_no_group_account BEFORE INSERT ON journal_lines
      WHEN (SELECT is_group FROM accounts WHERE id = NEW.account_id) = 1
      BEGIN SELECT RAISE(ABORT, 'ledger: cannot post to a group account'); END;

      -- Posted movements: the single source of truth for every report.
      CREATE VIEW ledger AS
        SELECT l.id, l.entry_id, e.number, e.date, e.reference, e.memo, e.source_type, e.source_id,
               l.line_no, l.account_id, l.party_id, l.description, l.debit, l.credit
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.status = 'posted';
    `,
  },
  {
    // Controlling dimension on every ledger line (like SAP's universal journal): the CO module
    // provides the cost centers; the ledger only stores the id.
    id: '002_cost_center_dimension',
    up: `
      ALTER TABLE journal_lines ADD COLUMN cost_center_id INTEGER;
      CREATE INDEX jl_cost_center ON journal_lines(cost_center_id) WHERE cost_center_id IS NOT NULL;
      DROP VIEW ledger;
      CREATE VIEW ledger AS
        SELECT l.id, l.entry_id, e.number, e.date, e.reference, e.memo, e.source_type, e.source_id,
               l.line_no, l.account_id, l.party_id, l.cost_center_id, l.description, l.debit, l.credit
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.status = 'posted';
    `,
  },
  {
    // Multi-currency: an account may be kept in a foreign currency (cash/bank); every line may carry its
    // foreign amount. Analysis: an expense account's variable share (cost behaviour) and a tag (lease).
    id: '003_currency_and_analysis',
    up: `
      ALTER TABLE accounts ADD COLUMN currency TEXT;
      ALTER TABLE accounts ADD COLUMN variable_bp INTEGER CHECK (variable_bp IS NULL OR variable_bp BETWEEN 0 AND 10000);
      ALTER TABLE accounts ADD COLUMN analysis_tag TEXT CHECK (analysis_tag IS NULL OR analysis_tag IN ('lease'));
      ALTER TABLE journal_lines ADD COLUMN currency TEXT;
      ALTER TABLE journal_lines ADD COLUMN amount_fx INTEGER;
      DROP VIEW ledger;
      CREATE VIEW ledger AS
        SELECT l.id, l.entry_id, e.number, e.date, e.reference, e.memo, e.source_type, e.source_id,
               l.line_no, l.account_id, l.party_id, l.cost_center_id, l.description, l.debit, l.credit,
               l.currency, l.amount_fx
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.status = 'posted';
      UPDATE accounts SET analysis_tag = 'lease' WHERE code = '5220' AND subtype = 'operating_expense';
    `,
  },
];
