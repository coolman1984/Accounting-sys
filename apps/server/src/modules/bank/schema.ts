import type { Migration } from '../../kernel/modules.js';

export const bankMigrations: Migration[] = [
  {
    id: '001_banking',
    up: `
      -- Money moved between two of the company's own cash / bank accounts.
      CREATE TABLE bank_transfers (
        id              INTEGER PRIMARY KEY,
        number          TEXT UNIQUE,
        date            TEXT NOT NULL,
        from_account_id INTEGER NOT NULL REFERENCES accounts(id),
        to_account_id   INTEGER NOT NULL REFERENCES accounts(id),
        amount          INTEGER NOT NULL CHECK (amount > 0),
        fee             INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
        fee_account_id  INTEGER REFERENCES accounts(id),
        reference       TEXT,
        memo            TEXT,
        status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
        entry_id        INTEGER REFERENCES journal_entries(id),
        created_by      INTEGER,
        created_at      TEXT NOT NULL,
        posted_at       TEXT,
        CHECK (from_account_id <> to_account_id)
      );

      -- A bank statement for one account and period; reconciling it ticks off ledger lines.
      CREATE TABLE bank_statements (
        id              INTEGER PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES accounts(id),
        date            TEXT NOT NULL,
        reference       TEXT,
        opening_balance INTEGER NOT NULL,
        closing_balance INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled')),
        created_by      INTEGER,
        created_at      TEXT NOT NULL,
        reconciled_at   TEXT
      );
      CREATE INDEX bs_account ON bank_statements(account_id, date);

      -- Statement lines: + money in, − money out. A line is matched to exactly one ledger line.
      CREATE TABLE bank_statement_lines (
        id              INTEGER PRIMARY KEY,
        statement_id    INTEGER NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
        line_no         INTEGER NOT NULL,
        date            TEXT NOT NULL,
        description     TEXT NOT NULL,
        reference       TEXT,
        amount          INTEGER NOT NULL CHECK (amount <> 0),
        journal_line_id INTEGER UNIQUE REFERENCES journal_lines(id)
      );
      CREATE INDEX bsl_statement ON bank_statement_lines(statement_id);

      -- A reconciled statement is history: its lines can no longer change.
      CREATE TRIGGER bsl_locked_update BEFORE UPDATE ON bank_statement_lines
      WHEN (SELECT status FROM bank_statements WHERE id = OLD.statement_id) = 'reconciled'
      BEGIN SELECT RAISE(ABORT, 'bank: statement is reconciled'); END;
      CREATE TRIGGER bsl_locked_delete BEFORE DELETE ON bank_statement_lines
      WHEN (SELECT status FROM bank_statements WHERE id = OLD.statement_id) = 'reconciled'
      BEGIN SELECT RAISE(ABORT, 'bank: statement is reconciled'); END;
      CREATE TRIGGER bsl_locked_insert BEFORE INSERT ON bank_statement_lines
      WHEN (SELECT status FROM bank_statements WHERE id = NEW.statement_id) = 'reconciled'
      BEGIN SELECT RAISE(ABORT, 'bank: statement is reconciled'); END;
    `,
  },
  {
    // Transfers between accounts in different currencies: what arrived, in the receiving account's currency.
    id: '002_fx',
    up: `ALTER TABLE bank_transfers ADD COLUMN to_amount INTEGER CHECK (to_amount IS NULL OR to_amount > 0);`,
  },
];
