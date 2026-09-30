import { isUuid, newUuidv7 } from '../../eco-contracts/index.js';
import type { Migration } from '../../kernel/modules.js';
import { nowIso } from '../../kernel/dates.js';

/**
 * The company id is the root of every global id Mizan mints (UUIDv5 namespace), so it is set once and
 * never changes (a trigger refuses it). A company that already has one in the ecosystem (another app
 * was installed first, or link-mizan used LINK_COMPANY_ID) passes it in MIZAN_ECO_COMPANY_ID before the
 * first start of this version; otherwise a new UUIDv7 is created.
 */
export const migrations: Migration[] = [
  {
    id: '001_eco',
    up(db) {
      db.exec(`
        CREATE TABLE eco_company (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          company_id TEXT NOT NULL,
          origin     TEXT NOT NULL CHECK (origin IN ('generated', 'configured')),
          created_at TEXT NOT NULL
        );
        CREATE TRIGGER eco_company_immutable BEFORE UPDATE ON eco_company
        BEGIN SELECT RAISE(ABORT, 'eco: the company id never changes'); END;
        CREATE TRIGGER eco_company_no_delete BEFORE DELETE ON eco_company
        BEGIN SELECT RAISE(ABORT, 'eco: the company id never changes'); END;

        -- Machine keys (x-eco-key): only the SHA-256 is kept.
        CREATE TABLE eco_keys (
          id         INTEGER PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          key_hash   TEXT NOT NULL UNIQUE,
          scopes     TEXT NOT NULL,
          active     INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );

        -- The feed: append-only, gap-free (one writer: SQLite serialises writes), written in the
        -- transaction of the business change it reports.
        CREATE TABLE eco_outbox (
          seq         INTEGER PRIMARY KEY,
          id          TEXT NOT NULL UNIQUE,
          type        TEXT NOT NULL,
          subject     TEXT NOT NULL,
          correlation TEXT NOT NULL,
          causation   TEXT,
          time        TEXT NOT NULL,
          data        TEXT NOT NULL
        );
        CREATE INDEX eco_outbox_corr ON eco_outbox(correlation, seq);
        CREATE INDEX eco_outbox_type ON eco_outbox(type, seq);
        CREATE TRIGGER eco_outbox_immutable BEFORE UPDATE ON eco_outbox
        BEGIN SELECT RAISE(ABORT, 'eco: published events are immutable'); END;
        CREATE TRIGGER eco_outbox_no_delete BEFORE DELETE ON eco_outbox
        BEGIN SELECT RAISE(ABORT, 'eco: published events are immutable'); END;

        -- What each consumer made of each published event (applied / parked / skipped).
        CREATE TABLE eco_ack (
          event_id   TEXT NOT NULL REFERENCES eco_outbox(id),
          consumer   TEXT NOT NULL,
          status     TEXT NOT NULL CHECK (status IN ('applied', 'parked', 'skipped')),
          code       TEXT,
          message    TEXT,
          target_ref TEXT,
          figures    TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (event_id, consumer)
        );

        -- Events received: (source, id) is remembered, so a redelivery is applied once.
        CREATE TABLE eco_inbox (
          source      TEXT NOT NULL,
          event_id    TEXT NOT NULL,
          type        TEXT NOT NULL,
          result      TEXT NOT NULL CHECK (result IN ('applied', 'unchanged', 'stale')),
          received_at TEXT NOT NULL,
          PRIMARY KEY (source, event_id)
        );
        -- Events refused (never silently): the last reason, until a later delivery is accepted.
        CREATE TABLE eco_inbox_rejects (
          source     TEXT NOT NULL,
          event_id   TEXT NOT NULL,
          type       TEXT,
          code       TEXT NOT NULL,
          message    TEXT,
          attempts   INTEGER NOT NULL DEFAULT 1,
          first_at   TEXT NOT NULL,
          last_at    TEXT NOT NULL,
          PRIMARY KEY (source, event_id)
        );

        -- The last snapshot published per entity: its fingerprint (no change = no new event) and version.
        CREATE TABLE eco_snapshots (
          type       TEXT NOT NULL,
          local_id   TEXT NOT NULL,
          global_id  TEXT NOT NULL,
          hash       TEXT NOT NULL,
          version    INTEGER NOT NULL,
          event_id   TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (type, local_id)
        );
        CREATE INDEX eco_snapshots_global ON eco_snapshots(global_id);

        -- Manufacturing's supply plan (mes.supply_plan.v1): what can be produced per item and month.
        CREATE TABLE eco_supply_plans (
          id          TEXT PRIMARY KEY,
          code        TEXT NOT NULL,
          version     INTEGER NOT NULL,
          mrp_run     TEXT NOT NULL,
          source      TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE TABLE eco_supply_plan (
          plan_id         TEXT NOT NULL REFERENCES eco_supply_plans(id),
          item_global_id  TEXT NOT NULL,
          item_code       TEXT NOT NULL,
          item_id         INTEGER,
          period          TEXT NOT NULL,
          demand_qty      INTEGER NOT NULL,
          planned_qty     INTEGER NOT NULL,
          constraint_kind TEXT NOT NULL CHECK (constraint_kind IN ('none', 'capacity', 'material', 'both')),
          PRIMARY KEY (plan_id, item_global_id, period)
        );
      `);
      const configured = process.env.MIZAN_ECO_COMPANY_ID?.trim().toLowerCase();
      if (configured && !isUuid(configured)) throw new Error(`MIZAN_ECO_COMPANY_ID is not a lower-case UUID: ${configured}`);
      db.run('INSERT INTO eco_company (id, company_id, origin, created_at) VALUES (1, ?, ?, ?)', [
        configured || newUuidv7(),
        configured ? 'configured' : 'generated',
        nowIso(),
      ]);
    },
  },
  {
    // Other applications this server talks to on its own (push its feed to their inbox, pull their feed).
    id: '002_peers',
    up: `
      CREATE TABLE eco_peers (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        url           TEXT NOT NULL,
        key_sealed    TEXT NOT NULL,                 -- the key the peer gave us (x-eco-key), sealed, never returned
        consumer      TEXT NOT NULL,                 -- our name at the peer (its key's name), used in acks
        push          INTEGER NOT NULL DEFAULT 1,    -- send our feed to its inbox
        pull          INTEGER NOT NULL DEFAULT 0,    -- read its feed into our inbox
        types         TEXT,                          -- space-separated event types to push (NULL = all)
        push_cursor   INTEGER NOT NULL DEFAULT 0,    -- last of OUR outbox seq the peer took
        pull_cursor   INTEGER NOT NULL DEFAULT 0,    -- last of ITS feed seq we took
        active        INTEGER NOT NULL DEFAULT 1,
        last_ok_at    TEXT,
        last_error    TEXT,
        created_at    TEXT NOT NULL
      );
    `,
  },
];
