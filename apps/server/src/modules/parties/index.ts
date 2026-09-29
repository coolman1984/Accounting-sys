import { z } from 'zod';
import type { AppModule, ModuleContext, SessionUser } from '../../kernel/modules.js';
import { AppError, conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { paging, parse, zDate, zOptId, zOptText } from '../../kernel/validate.js';
import type { Party, PartiesService, PartyKind, PartyRoleInfo } from '../../contracts/parties.js';
import type {} from '../../contracts/eco.js';

const zParty = z.object({
  kind: z.enum(['customer', 'supplier', 'both']),
  code: zOptText(30),
  name: z.string().trim().min(1).max(200),
  nameAlt: zOptText(200),
  taxNumber: zOptText(50),
  email: zOptText(200),
  phone: zOptText(50),
  address: zOptText(500),
  city: zOptText(100),
  country: zOptText(100),
  receivableAccountId: zOptId.transform((v) => v ?? null),
  payableAccountId: zOptId.transform((v) => v ?? null),
  paymentTermsDays: z.number().int().min(0).max(3650).default(0),
  creditLimit: z.number().int().min(0).nullish().transform((v) => v ?? null),
  whtType: z.enum(['supplies', 'contracting', 'services', 'commissions']).nullish().transform((v) => v ?? null),
  notes: zOptText(2000),
  isActive: z.boolean().default(true),
});

const checkControlAccounts = (services: ModuleContext['services'], input: z.infer<typeof zParty>) => {
  const ledger = services.get('ledger');
  if (input.receivableAccountId && ledger.account(input.receivableAccountId).subtype !== 'receivable') {
    fail('party.bad_account', 'The receivable account must be an Accounts Receivable account');
  }
  if (input.payableAccountId && ledger.account(input.payableAccountId).subtype !== 'payable') {
    fail('party.bad_account', 'The payable account must be an Accounts Payable account');
  }
};

const row = (input: z.infer<typeof zParty>) => ({
  kind: input.kind,
  name: input.name,
  name_alt: input.nameAlt,
  tax_number: input.taxNumber,
  email: input.email,
  phone: input.phone,
  address: input.address,
  city: input.city,
  country: input.country,
  receivable_account_id: input.receivableAccountId,
  payable_account_id: input.payableAccountId,
  payment_terms_days: input.paymentTermsDays,
  credit_limit: input.creditLimit,
  wht_type: input.whtType,
  notes: input.notes,
  is_active: input.isActive,
});


function createParties({ db, services }: ModuleContext): PartiesService {
  // Customers and suppliers exist only when AR / AP plug their role in.
  const roles = new Map<'customer' | 'supplier', PartyRoleInfo>();
  return {
    registerRole(kind, info) {
      roles.set(kind, info);
    },
    role: (kind) => roles.get(kind) ?? null,
    get(id) {
      return db.get<Party>('SELECT * FROM parties WHERE id = ?', [id]) ?? notFound('party', id);
    },
    names(ids) {
      if (ids.length === 0) return new Map();
      const unique = [...new Set(ids)];
      const rows = db.all<{ id: number; name: string }>(
        `SELECT id, name FROM parties WHERE id IN (${unique.map(() => '?').join(',')})`,
        unique,
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    },
    receivableAccount: (p) => p.receivable_account_id ?? services.get('ledger').defaultAccount('receivable'),
    payableAccount: (p) => p.payable_account_id ?? services.get('ledger').defaultAccount('payable'),
    /** Create a customer or supplier from the same input as POST /parties (validated here); the caller checks rights. */
    create(raw, userId) {
      const input = parse(zParty, raw);
      checkControlAccounts(services, input);
      return db.tx(() => {
        const code = input.code || services.get('sequences').next(input.kind === 'supplier' ? 'supplier' : 'customer');
        if (db.get('SELECT 1 FROM parties WHERE code = ?', [code])) conflict('party.duplicate_code', `Code ${code} already exists`);
        const id = db.insert('parties', { ...row(input), code, created_at: nowIso() });
        services.get('audit').log({ userId, action: 'create', entity: 'party', entityId: id, summary: input.name });
        partyChanged(services, id);
        return { id, code };
      });
    },
    assertKind(p, kind) {
      if (p.kind !== 'both' && p.kind !== kind) {
        fail(kind === 'customer' ? 'party.not_customer' : 'party.not_supplier', `${p.name} is not a ${kind}`);
      }
      if (!p.is_active) fail('party.inactive', `${p.name} is inactive`);
    },
  };
}

const PARTY_V1 = 'eco.party.v1';
const partyChanged = (services: ModuleContext['services'], id: number) => services.has('eco') && services.get('eco').changed(PARTY_V1, id);

/**
 * Mizan owns customers and suppliers: publish who they are (eco.party.v1) — never credit, prices or bank data.
 * The country goes out only when it is an ISO 3166 alpha-2 code (the field is free text here).
 */
function publishParties({ db, services }: ModuleContext) {
  if (!services.has('eco')) return;
  services.get('eco').registerSnapshot({
    type: PARTY_V1,
    entity: 'party',
    all: () => db.all<{ id: number }>('SELECT id FROM parties ORDER BY id').map((r) => String(r.id)),
    build(localId, h) {
      const p = db.get<Party>('SELECT * FROM parties WHERE id = ?', [Number(localId)]);
      if (!p) return null;
      const country = (p.country ?? '').trim().toUpperCase();
      return {
        id: h.id('party', p.id),
        code: p.code,
        origin: h.origin('party', p.id),
        name: { en: p.name, ar: p.name_alt || p.name },
        roles: p.kind === 'both' ? ['customer', 'supplier'] : [p.kind],
        ...(/^[A-Z]{2}$/.test(country) ? { country } : {}),
        active: !!p.is_active,
      };
    },
  });
}

export const partiesModule: AppModule = {
  id: 'parties',
  dependsOn: ['ledger'],
  after: ['eco'],
  // No permissions of its own: customers are guarded by AR (ar.customers.*), suppliers by AP (ap.suppliers.*).
  migrations: [
    {
      id: '001_parties',
      up: `
        CREATE TABLE parties (
          id                    INTEGER PRIMARY KEY,
          kind                  TEXT NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
          code                  TEXT NOT NULL UNIQUE,
          name                  TEXT NOT NULL,
          name_alt              TEXT,               -- name in the other language
          tax_number            TEXT,
          email                 TEXT,
          phone                 TEXT,
          address               TEXT,
          city                  TEXT,
          country               TEXT,
          receivable_account_id INTEGER REFERENCES accounts(id),
          payable_account_id    INTEGER REFERENCES accounts(id),
          payment_terms_days    INTEGER NOT NULL DEFAULT 0,
          credit_limit          INTEGER,            -- minor units, null = unlimited
          notes                 TEXT,
          is_active             INTEGER NOT NULL DEFAULT 1,
          created_at            TEXT NOT NULL
        );
        CREATE INDEX parties_kind ON parties(kind, is_active);
        CREATE INDEX parties_name ON parties(name);
      `,
    },
    {
      // Egypt: the withholding type this party's payments fall under (1% supplies, 3% services …).
      id: '002_withholding',
      up: `ALTER TABLE parties ADD COLUMN wht_type TEXT CHECK (wht_type IS NULL OR wht_type IN ('supplies', 'contracting', 'services', 'commissions'));`,
    },
  ],

  setup(ctx) {
    ctx.services.provide('parties', createParties(ctx));
    publishParties(ctx);
    ctx.events.on('system.setup', () => {
      const seq = ctx.services.get('sequences');
      seq.ensure('customer', 'C-', 4);
      seq.ensure('supplier', 'S-', 4);
    });
  },

  routes(r, { db, services }) {
    const parties = services.get('parties');
    const audit = services.get('audit');

    /** The partner roles a party plays. */
    const rolesOf = (kind: PartyKind): ('customer' | 'supplier')[] => (kind === 'both' ? ['customer', 'supplier'] : [kind]);
    const allowed = (user: SessionUser, role: 'customer' | 'supplier', action: 'read' | 'write') => {
      const info = parties.role(role);
      return !!info && user.permissions.has(`${info.perm}.${action}`);
    };
    /** Reading needs the right for any role the party plays; changing needs it for all of them. */
    const need = (user: SessionUser, kind: PartyKind, action: 'read' | 'write') => {
      const list = rolesOf(kind);
      const ok = action === 'read' ? list.some((x) => allowed(user, x, action)) : list.every((x) => allowed(user, x, action));
      if (!ok) {
        const perm = list.map((x) => `${parties.role(x)?.perm ?? x}.${action}`).join(' / ');
        throw new AppError('auth.forbidden', 'You do not have permission for this action', 403, { permission: perm });
      }
    };

    /** Current balances for a set of parties: receivable (they owe us) and payable (we owe them). */
    const balances = (asOf?: string | null) => {
      const rows = db.all<{ party_id: number; receivable: number; payable: number }>(
        `SELECT l.party_id,
                SUM(CASE WHEN a.subtype = 'receivable' THEN l.debit - l.credit ELSE 0 END) AS receivable,
                SUM(CASE WHEN a.subtype = 'payable' THEN l.credit - l.debit ELSE 0 END) AS payable
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE l.party_id IS NOT NULL ${asOf ? 'AND l.date <= :asOf' : ''}
         GROUP BY l.party_id`,
        asOf ? { asOf } : {},
      );
      return new Map(rows.map((x) => [x.party_id, x]));
    };

    r.get('/parties', 'auth', ({ query, user }) => {
      const { limit, offset } = paging(query, 200);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.kind === 'customer' || query.kind === 'supplier') {
        need(user, query.kind, 'read');
        where.push(`kind IN ('${query.kind}', 'both')`);
      } else {
        // Without a kind: only the roles this user may see.
        const kinds = (['customer', 'supplier'] as const).filter((k) => allowed(user, k, 'read'));
        if (!kinds.length) need(user, 'customer', 'read');
        if (kinds.length === 1) where.push(`kind IN ('${kinds[0]}', 'both')`);
      }
      if (query.active === '1') where.push('is_active = 1');
      if (query.q) {
        where.push('(name LIKE :q OR code LIKE :q OR name_alt LIKE :q OR phone LIKE :q OR tax_number LIKE :q)');
        p.q = `%${query.q}%`;
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all<Party>(`SELECT * FROM parties ${w} ORDER BY name LIMIT :limit OFFSET :offset`, { ...p, limit, offset });
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM parties ${w}`, p)!.n;
      const bal = balances();
      return {
        rows: rows.map((x) => ({ ...x, receivable: bal.get(x.id)?.receivable ?? 0, payable: bal.get(x.id)?.payable ?? 0 })),
        total,
      };
    });

    r.get('/parties/:id', 'auth', ({ params, user }) => {
      const p = parties.get(Number(params.id));
      need(user, p.kind, 'read');
      const b = balances().get(p.id);
      return { ...p, receivable: b?.receivable ?? 0, payable: b?.payable ?? 0 };
    });

    r.post('/parties', 'auth', ({ body, user }) => {
      const input = parse(zParty, body);
      need(user, input.kind, 'write');
      return parties.create(input, user.id);
    });

    r.put('/parties/:id', 'auth', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = parties.get(id);
      const input = parse(zParty, body);
      need(user, cur.kind, 'write');
      need(user, input.kind, 'write');
      checkControlAccounts(services, input);
      const code = input.code || cur.code;
      const dup = db.get<{ id: number }>('SELECT id FROM parties WHERE code = ?', [code]);
      if (dup && dup.id !== id) conflict('party.duplicate_code', `Code ${code} already exists`);
      db.tx(() => {
        db.update('parties', id, { ...row(input), code });
        audit.log({ userId: user.id, action: 'update', entity: 'party', entityId: id, data: { before: cur, after: input } });
        partyChanged(services, id);
      });
      return { ok: true };
    });

    r.delete('/parties/:id', 'auth', ({ params, user }) => {
      const id = Number(params.id);
      const cur = parties.get(id);
      need(user, cur.kind, 'write');
      if (db.get('SELECT 1 FROM journal_lines WHERE party_id = ? LIMIT 1', [id])) {
        conflict('party.in_use', 'This party has transactions — deactivate it instead');
      }
      db.tx(() => {
        db.run('DELETE FROM parties WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'party', entityId: id, summary: cur.name });
      });
      return { ok: true };
    });

    /** Statement of account: every AR/AP movement with a running balance. */
    r.get('/parties/:id/statement', 'auth', ({ params, query, user }) => {
      const p = parties.get(Number(params.id));
      need(user, p.kind, 'read');
      const q = parse(z.object({ from: zDate.nullish(), to: zDate.nullish() }), query);
      // Positive balance = the party owes us (debit balance); negative = we owe them.
      const opening = q.from
        ? db.get<{ bal: number }>(
            `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS bal
             FROM ledger l JOIN accounts a ON a.id = l.account_id
             WHERE l.party_id = ? AND a.subtype IN ('receivable', 'payable') AND l.date < ?`,
            [p.id, q.from],
          )!.bal
        : 0;
      const where = ['l.party_id = :pid', "a.subtype IN ('receivable', 'payable')"];
      const prm: Record<string, string | number> = { pid: p.id };
      if (q.from) (where.push('l.date >= :from'), (prm.from = q.from));
      if (q.to) (where.push('l.date <= :to'), (prm.to = q.to));
      const lines = db.all<{ debit: number; credit: number }>(
        `SELECT l.entry_id, l.number, l.date, l.reference, l.memo, l.source_type, l.source_id, l.description, l.debit, l.credit
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE ${where.join(' AND ')} ORDER BY l.date, l.entry_id, l.line_no`,
        prm,
      );
      let running = opening;
      const rows = lines.map((l) => {
        running += l.debit - l.credit;
        return { ...l, balance: running };
      });
      return { party: p, from: q.from ?? null, to: q.to ?? null, opening, closing: running, rows };
    });
  },
};
