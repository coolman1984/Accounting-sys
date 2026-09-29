import type { Migration } from '../../kernel/modules.js';

export const CONSTRAINTS = ['none', 'capacity', 'material', 'both'] as const;

export const migrations: Migration[] = [
  {
    id: '001_sop',
    up: `
      -- One monthly S&OP cycle ("S&OP 2026-10"), planning a horizon of months from start_month.
      CREATE TABLE sop_cycles (
        id          INTEGER PRIMARY KEY,
        period      TEXT NOT NULL UNIQUE,                 -- YYYY-MM
        name        TEXT NOT NULL,
        start_month TEXT NOT NULL,                        -- first planned month, YYYY-MM
        months      INTEGER NOT NULL DEFAULT 12 CHECK (months BETWEEN 1 AND 24),
        notes       TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT NOT NULL
      );

      -- Versions of the demand plan; approving one (consensus) supersedes the previous approved one.
      CREATE TABLE sop_versions (
        id              INTEGER PRIMARY KEY,
        cycle_id        INTEGER NOT NULL REFERENCES sop_cycles(id) ON DELETE CASCADE,
        version_no      INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
        baseline_months INTEGER NOT NULL DEFAULT 3 CHECK (baseline_months BETWEEN 1 AND 24),
        price_list_id   INTEGER,
        notes           TEXT,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        approved_by     INTEGER REFERENCES users(id),
        approved_at     TEXT,
        superseded_at   TEXT,
        UNIQUE (cycle_id, version_no)
      );
      CREATE UNIQUE INDEX sop_versions_one_approved ON sop_versions(cycle_id) WHERE status = 'approved';

      -- Demand per item × month: statistical baseline, firm open orders, a manual override, the consensus quantity and its value.
      CREATE TABLE sop_demand (
        id           INTEGER PRIMARY KEY,
        version_id   INTEGER NOT NULL REFERENCES sop_versions(id) ON DELETE CASCADE,
        item_id      INTEGER NOT NULL REFERENCES items(id),
        month        TEXT NOT NULL,
        baseline_qty INTEGER NOT NULL DEFAULT 0,
        firm_qty     INTEGER NOT NULL DEFAULT 0,
        override_qty INTEGER CHECK (override_qty IS NULL OR override_qty >= 0),
        qty          INTEGER NOT NULL CHECK (qty >= 0),
        unit_price   INTEGER NOT NULL DEFAULT 0,
        amount       INTEGER NOT NULL DEFAULT 0,
        UNIQUE (version_id, item_id, month)
      );

      -- Planned supply per item × month and what limits it (filled from the manufacturing system).
      CREATE TABLE sop_supply_plan (
        id          INTEGER PRIMARY KEY,
        item_id     INTEGER NOT NULL REFERENCES items(id),
        month       TEXT NOT NULL,
        planned_qty INTEGER NOT NULL CHECK (planned_qty >= 0),
        constraint_type TEXT NOT NULL DEFAULT 'none' CHECK (constraint_type IN ('none', 'capacity', 'material', 'both')),
        source      TEXT NOT NULL DEFAULT 'manual',
        reference   TEXT,
        updated_at  TEXT NOT NULL,
        UNIQUE (item_id, month)
      );

      -- An approved or superseded plan is the record of a decision: its figures never change.
      CREATE TRIGGER sop_demand_frozen_ins BEFORE INSERT ON sop_demand
      WHEN (SELECT status FROM sop_versions WHERE id = NEW.version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sop: approved plans are frozen'); END;
      CREATE TRIGGER sop_demand_frozen_upd BEFORE UPDATE ON sop_demand
      WHEN (SELECT status FROM sop_versions WHERE id = OLD.version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sop: approved plans are frozen'); END;
      CREATE TRIGGER sop_demand_frozen_del BEFORE DELETE ON sop_demand
      WHEN (SELECT status FROM sop_versions WHERE id = OLD.version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sop: approved plans are frozen'); END;
      CREATE TRIGGER sop_versions_no_delete BEFORE DELETE ON sop_versions
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'sop: approved plans cannot be deleted'); END;
      CREATE TRIGGER sop_versions_status BEFORE UPDATE OF status ON sop_versions
      WHEN NOT ((OLD.status = 'draft' AND NEW.status = 'approved') OR (OLD.status = 'approved' AND NEW.status = 'superseded') OR OLD.status = NEW.status)
      BEGIN SELECT RAISE(ABORT, 'sop: a plan goes draft → approved → superseded'); END;
    `,
  },
];
