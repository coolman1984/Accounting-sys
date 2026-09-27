import type { Migration } from '../../kernel/modules.js';

export const migrations: Migration[] = [
  {
    id: '001_core',
    up: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL            -- JSON
      );

      -- Gap-free document numbering (JE-00001, INV-00001 …)
      CREATE TABLE sequences (
        key        TEXT PRIMARY KEY,
        prefix     TEXT NOT NULL,
        next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value > 0),
        padding    INTEGER NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 12)
      );

      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'accountant', 'viewer')),
        locale        TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        id         TEXT PRIMARY KEY,   -- sha256(token); the raw token only lives in the cookie
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip         TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE audit_log (
        id        INTEGER PRIMARY KEY,
        at        TEXT NOT NULL,
        user_id   INTEGER REFERENCES users(id),
        action    TEXT NOT NULL,       -- create | update | delete | post | void | reverse | login …
        entity    TEXT NOT NULL,       -- journal_entry | document | account …
        entity_id INTEGER,
        summary   TEXT,
        data      TEXT                 -- JSON snapshot / diff
      );
      CREATE INDEX audit_entity ON audit_log(entity, entity_id);
      CREATE INDEX audit_at ON audit_log(at);

      -- The audit trail is append-only.
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    `,
  },
  {
    // Roles like SAP / ERPNext: a role is a set of permissions, a user holds several roles.
    // Built-in roles follow a rule so they always cover permissions of modules installed later;
    // custom roles list their permissions. users.role is kept only for old installs.
    id: '002_roles',
    up: `
      CREATE TABLE roles (
        id          INTEGER PRIMARY KEY,
        key         TEXT UNIQUE,                 -- built-in roles: admin | accountant | viewer
        name        TEXT NOT NULL,
        description TEXT,
        rule        TEXT CHECK (rule IN ('all', 'all_but_admin', 'read_only')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE role_permissions (
        role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        PRIMARY KEY (role_id, permission)
      );
      CREATE TABLE user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );
      INSERT INTO roles (key, name, rule, created_at, updated_at) VALUES
        ('admin', 'Administrator', 'all', datetime('now'), datetime('now')),
        ('accountant', 'Accountant', 'all_but_admin', datetime('now'), datetime('now')),
        ('viewer', 'Viewer', 'read_only', datetime('now'), datetime('now'));
      INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.key = u.role;
    `,
  },
];
