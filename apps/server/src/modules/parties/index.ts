import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { paging, parse, zDate, zOptId, zOptText } from '../../kernel/validate.js';

export type PartyKind = 'customer' | 'supplier' | 'both';

export interface Party {
  id: number;
  kind: PartyKind;
  code: string;
  name: string;
  name_alt: string | null;
  tax_number: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  receivable_account_id: number | null;
  payable_account_id: number | null;
  payment_terms_days: number;
  credit_limit: number | null;
  notes: string | null;
  is_active: number;
  created_at: string;
}

export interface PartiesService {
  get(id: number): Party;
  names(ids: number[]): Map<number, string>;
  /** The AR control account for a customer (its own or the default). */
  receivableAccount(p: Party): number;
  /** The AP control account for a supplier (its own or the default). */
  payableAccount(p: Party): number;
  assertKind(p: Party, kind: 'customer' | 'supplier'): void;
}

declare module '../../kernel/services.js' {
  interface ServiceMap {
    parties: PartiesService;
  }
}

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
  notes: zOptText(2000),
  isActive: z.boolean().default(true),
});

function createParties({ db, services }: ModuleContext): PartiesService {
  return {
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
    assertKind(p, kind) {
      if (p.kind !== 'both' && p.kind !== kind) {
        fail(kind === 'customer' ? 'party.not_customer' : 'party.not_supplier', `${p.name} is not a ${kind}`);
      }
      if (!p.is_active) fail('party.inactive', `${p.name} is inactive`);
    },
  };
}

export const partiesModule: AppModule = {
  id: 'parties',
  dependsOn: ['ledger'],
  permissions: ['parties.read', 'parties.write'],
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
  ],

  setup(ctx) {
    ctx.services.provide('parties', createParties(ctx));
    ctx.events.on('system.setup', () => {
      const seq = ctx.services.get('sequences');
      seq.ensure('customer', 'C-', 4);
      seq.ensure('supplier', 'S-', 4);
    });
  },

  routes(r, { db, services }) {
    const parties = services.get('parties');
    const audit = services.get('audit');

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

    r.get('/parties', 'parties.read', ({ query }) => {
      const { limit, offset } = paging(query, 200);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.kind === 'customer') where.push("kind IN ('customer', 'both')");
      if (query.kind === 'supplier') where.push("kind IN ('supplier', 'both')");
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

    r.get('/parties/:id', 'parties.read', ({ params }) => {
      const p = parties.get(Number(params.id));
      const b = balances().get(p.id);
      return { ...p, receivable: b?.receivable ?? 0, payable: b?.payable ?? 0 };
    });

    const checkControlAccounts = (input: z.infer<typeof zParty>) => {
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
      notes: input.notes,
      is_active: input.isActive,
    });

    r.post('/parties', 'parties.write', ({ body, user }) => {
      const input = parse(zParty, body);
      checkControlAccounts(input);
      return db.tx(() => {
        const code = input.code || services.get('sequences').next(input.kind === 'supplier' ? 'supplier' : 'customer');
        if (db.get('SELECT 1 FROM parties WHERE code = ?', [code])) conflict('party.duplicate_code', `Code ${code} already exists`);
        const id = db.insert('parties', { ...row(input), code, created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'party', entityId: id, summary: input.name });
        return { id, code };
      });
    });

    r.put('/parties/:id', 'parties.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = parties.get(id);
      const input = parse(zParty, body);
      checkControlAccounts(input);
      const code = input.code || cur.code;
      const dup = db.get<{ id: number }>('SELECT id FROM parties WHERE code = ?', [code]);
      if (dup && dup.id !== id) conflict('party.duplicate_code', `Code ${code} already exists`);
      db.tx(() => {
        db.update('parties', id, { ...row(input), code });
        audit.log({ userId: user.id, action: 'update', entity: 'party', entityId: id, data: { before: cur, after: input } });
      });
      return { ok: true };
    });

    r.delete('/parties/:id', 'parties.write', ({ params, user }) => {
      const id = Number(params.id);
      const cur = parties.get(id);
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
    r.get('/parties/:id/statement', 'parties.read', ({ params, query }) => {
      const p = parties.get(Number(params.id));
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
