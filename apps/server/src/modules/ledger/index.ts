import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { conflict, forbidden } from '../../kernel/errors.js';
import { addDays, addMonths } from '../../kernel/dates.js';
import { paging, parse, zDate, zId, zMinor, zOptId, zOptText } from '../../kernel/validate.js';
import { ACCOUNT_TYPES, DEBIT_NORMAL, SUBTYPES, migrations, type AccountType } from './schema.js';
import { createLedger, type LedgerService } from './service.js';
import { DEFAULT_ACCOUNT_KEYS, MINIMAL_CHART, STANDARD_CHART } from './chart-template.js';

declare module '../../kernel/services.js' {
  interface ServiceMap {
    ledger: LedgerService;
  }
}

const zAccount = z
  .object({
    code: z.string().trim().min(1).max(20).regex(/^[0-9A-Za-z.-]+$/),
    nameEn: z.string().trim().min(1).max(200),
    nameAr: z.string().trim().min(1).max(200),
    type: z.enum(ACCOUNT_TYPES),
    subtype: z.string(),
    parentId: zOptId.transform((v) => v ?? null),
    isGroup: z.boolean().default(false),
    isActive: z.boolean().default(true),
    description: zOptText(1000),
  });

const zLine = z.object({
  accountId: zId,
  debit: zMinor.default(0),
  credit: zMinor.default(0),
  description: zOptText(500),
  partyId: zOptId.transform((v) => v ?? null),
});

const zEntry = z.object({
  date: zDate,
  reference: zOptText(100),
  memo: zOptText(1000),
  lines: z.array(zLine).min(1).max(500),
  post: z.boolean().default(false),
  opening: z.boolean().default(false),
});

export const ledgerModule: AppModule = {
  id: 'ledger',
  dependsOn: ['system'],
  migrations,
  permissions: ['accounts.read', 'accounts.write', 'journal.read', 'journal.write', 'journal.post', 'fiscal.manage'],
  apps: [{ id: 'accounting', core: true, order: 0, permissions: ['accounts', 'journal', 'fiscal'] }],
  health({ db }) {
    const t = db.get<{ d: number; c: number }>('SELECT COALESCE(SUM(debit), 0) d, COALESCE(SUM(credit), 0) c FROM ledger')!;
    const unbalanced = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM (SELECT entry_id FROM ledger GROUP BY entry_id HAVING SUM(debit) <> SUM(credit))`,
    )!.n;
    return [
      { id: 'balanced', ok: t.d === t.c, details: { difference: t.d - t.c } },
      { id: 'entries', ok: unbalanced === 0, details: { count: unbalanced } },
    ];
  },

  setup(ctx) {
    const ledger = createLedger(ctx);
    ctx.services.provide('ledger', ledger);

    ctx.events.on('system.setup', (s) => {
      ctx.services.get('sequences').ensure('journal', 'JE-', 6);
      ledger.seedChart(s.seedChartOfAccounts ? STANDARD_CHART : MINIMAL_CHART);
      const end = addDays(addMonths(s.fiscalYearStart, 12), -1);
      ledger.createFiscalYear({ startDate: s.fiscalYearStart, endDate: end }, null);
    });
  },

  routes(r, { db, services }) {
    const ledger = services.get('ledger');

    // ----------------------------------------------------------- accounts
    r.get('/accounts/meta', 'accounts.read', () => ({
      types: ACCOUNT_TYPES,
      subtypes: SUBTYPES,
      defaultKeys: DEFAULT_ACCOUNT_KEYS,
      defaults: ledger.defaultAccounts(),
    }));

    /** Chart of accounts with balances (net, in the account's normal direction) rolled up the tree. */
    r.get('/accounts', 'accounts.read', ({ query }) => {
      const accounts = ledger.accounts();
      const mv = ledger.movements({ to: query.asOf || null });
      const balance = new Map<number, number>();
      for (const a of accounts) {
        const m = mv.get(a.id);
        const net = m ? m.debit - m.credit : 0;
        balance.set(a.id, DEBIT_NORMAL.has(a.type) ? net : -net);
      }
      // Roll children into parents (deepest first).
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const depth = (id: number): number => {
        let d = 0;
        let p = byId.get(id)?.parent_id;
        while (p) {
          d++;
          p = byId.get(p)?.parent_id;
        }
        return d;
      };
      const withDepth = accounts.map((a) => ({ a, d: depth(a.id) }));
      for (const { a } of [...withDepth].sort((x, y) => y.d - x.d)) {
        if (a.parent_id) balance.set(a.parent_id, (balance.get(a.parent_id) ?? 0) + (balance.get(a.id) ?? 0));
      }
      const used = new Set(db.all<{ account_id: number }>('SELECT DISTINCT account_id FROM journal_lines').map((x) => x.account_id));
      return withDepth.map(({ a, d }) => ({ ...a, depth: d, balance: balance.get(a.id) ?? 0, has_postings: used.has(a.id) }));
    });

    r.get('/accounts/:id', 'accounts.read', ({ params }) => ledger.account(Number(params.id)));

    r.post('/accounts', 'accounts.write', ({ body, user }) => {
      const input = parse(zAccount, body);
      return { id: ledger.createAccount(input, user.id) };
    });

    r.put('/accounts/:id', 'accounts.write', ({ params, body, user }) => {
      const input = parse(zAccount, body);
      ledger.updateAccount(Number(params.id), input, user.id);
      return { ok: true };
    });

    r.delete('/accounts/:id', 'accounts.write', ({ params, user }) => {
      ledger.deleteAccount(Number(params.id), user.id);
      return { ok: true };
    });

    r.put('/accounts-defaults', 'settings.manage', ({ body, user }) => {
      const shape = Object.fromEntries(DEFAULT_ACCOUNT_KEYS.map((k) => [k, zOptId]));
      const input = parse(z.object(shape).partial(), body) as Record<string, number | null | undefined>;
      const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Record<string, number | null>;
      ledger.setDefaultAccounts(clean, user.id);
      return ledger.defaultAccounts();
    });

    // ------------------------------------------------------- fiscal years
    r.get('/fiscal-years', 'journal.read', () => ledger.fiscalYears());

    r.post('/fiscal-years', 'fiscal.manage', ({ body, user }) => {
      const input = parse(z.object({ name: z.string().trim().max(50).optional(), startDate: zDate, endDate: zDate }), body);
      return { id: ledger.createFiscalYear(input, user.id) };
    });

    r.post('/fiscal-years/:id/close', 'fiscal.manage', ({ params, user }) => ledger.closeFiscalYear(Number(params.id), user.id));

    r.post('/fiscal-years/:id/reopen', 'fiscal.manage', ({ params, user }) => {
      ledger.reopenFiscalYear(Number(params.id), user.id);
      return { ok: true };
    });

    // ------------------------------------------------------------ journal
    r.get('/journal', 'journal.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.from) (where.push('e.date >= :from'), (p.from = query.from));
      if (query.to) (where.push('e.date <= :to'), (p.to = query.to));
      if (query.status) (where.push('e.status = :status'), (p.status = query.status));
      if (query.source) (where.push('e.source_type = :source'), (p.source = query.source));
      if (query.accountId) {
        where.push('EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_id = :acc)');
        p.acc = Number(query.accountId);
      }
      if (query.q) {
        where.push("(e.number LIKE :q OR e.reference LIKE :q OR e.memo LIKE :q)");
        p.q = `%${query.q}%`;
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT e.id, e.number, e.date, e.reference, e.memo, e.source_type, e.source_id, e.status, e.total,
                e.reversal_of_id, e.reversed_by_id, e.created_at, u.display_name AS created_by_name
         FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by
         ${w} ORDER BY e.date DESC, e.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM journal_entries e ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/journal/:id', 'journal.read', ({ params }) => {
      const e = ledger.entry(Number(params.id));
      // Party names come from the parties module when it is plugged in.
      const ids = e.lines.map((l) => l.party_id).filter((x): x is number => x != null);
      const names = services.has('parties') ? services.get('parties').names(ids) : new Map<number, string>();
      return { ...e, lines: e.lines.map((l) => ({ ...l, party_name: l.party_id ? names.get(l.party_id) ?? null : null })) };
    });

    r.post('/journal', 'journal.write', ({ body, user }) => {
      const input = parse(zEntry, body);
      if (input.post && !user.permissions.has('journal.post')) forbidden('journal.post');
      const id = ledger.createEntry(input, {
        sourceType: input.opening ? 'opening' : 'manual',
        post: input.post,
        userId: user.id,
      });
      return { id };
    });

    r.put('/journal/:id', 'journal.write', ({ params, body, user }) => {
      const id = Number(params.id);
      if (!ledger.isManual(id)) conflict('journal.not_manual', 'This entry belongs to a document; edit the document instead');
      const input = parse(zEntry, body);
      if (input.post && !user.permissions.has('journal.post')) forbidden('journal.post');
      db.tx(() => {
        ledger.updateDraft(id, input, user.id);
        if (input.post) ledger.postEntry(id, user.id);
      });
      return { id };
    });

    r.post('/journal/:id/post', 'journal.post', ({ params, user }) => {
      const id = Number(params.id);
      if (!ledger.isManual(id)) conflict('journal.not_manual', 'Post the source document instead');
      ledger.postEntry(id, user.id);
      return { ok: true };
    });

    r.post('/journal/:id/reverse', 'journal.post', ({ params, body, user }) => {
      const id = Number(params.id);
      if (!ledger.isManual(id)) conflict('journal.not_manual', 'Void the source document instead');
      const input = parse(z.object({ date: zDate.nullish(), memo: zOptText(500) }), body ?? {});
      return { id: ledger.reverseEntry(id, input, user.id) };
    });

    r.delete('/journal/:id', 'journal.write', ({ params, user }) => {
      const id = Number(params.id);
      if (!ledger.isManual(id)) conflict('journal.not_manual', 'This entry belongs to a document');
      ledger.deleteDraft(id, user.id);
      return { ok: true };
    });
  },
};

export type { AccountType };
