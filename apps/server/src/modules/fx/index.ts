import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { assertApp, conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { fxToBase } from '../../kernel/money.js';
import { parse, zDate } from '../../kernel/validate.js';
import { ON_DEMAND } from '../ledger/chart-template.js';
import type { JournalLineInput } from '../ledger/service.js';
import type { Currency, FxService } from '../../contracts/fx.js';

/** Currencies offered out of the box (the company's own is skipped). */
const SEED: [string, string, string, string][] = [
  ['USD', 'US Dollar', 'دولار أمريكي', '$'],
  ['EUR', 'Euro', 'يورو', '€'],
  ['GBP', 'Pound Sterling', 'جنيه إسترليني', '£'],
  ['SAR', 'Saudi Riyal', 'ريال سعودي', 'ر.س'],
  ['AED', 'UAE Dirham', 'درهم إماراتي', 'د.إ'],
  ['KWD', 'Kuwaiti Dinar', 'دينار كويتي', 'د.ك'],
  ['QAR', 'Qatari Riyal', 'ريال قطري', 'ر.ق'],
  ['CNY', 'Chinese Yuan', 'يوان صيني', '¥'],
  ['TRY', 'Turkish Lira', 'ليرة تركية', '₺'],
  ['EGP', 'Egyptian Pound', 'جنيه مصري', 'ج.م'],
];

const zCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
/** Rates are typed as decimals ("48.35") in the browser and sent as integers × 1,000,000. */
const zRate = z.number().int().positive().max(1e15);

function createFx({ db, services }: ModuleContext): FxService {
  const base = () => services.get('settings').company().baseCurrency;
  return {
    base,
    isForeign: (code) => !!code && code !== base(),
    assertCurrency(code) {
      const c = db.get<Currency>('SELECT * FROM currencies WHERE code = ?', [code]);
      if (!c) return notFound('currency', code);
      if (!c.is_active) fail('fx.inactive', `${code} is switched off`, { currency: code });
      return c;
    },
    rate(code, date) {
      if (code === base()) return 1_000_000;
      const r = db.get<{ rate: number }>('SELECT rate FROM exchange_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1', [code, date]);
      if (!r) return fail('fx.no_rate', `No ${code} rate on or before ${date} — enter one under Currencies`, { currency: code, date });
      return r.rate;
    },
    toBase: fxToBase,
  };
}

interface OpenItem {
  side: 'receivable' | 'payable';
  currency: string;
  fx: number;
  carrying: number;
}

/**
 * Multi-currency (IAS 21, kept simple): currencies, daily rates, and the period-end
 * revaluation of what is still open in a foreign currency. Documents and payments take
 * their rate from here; realised differences are booked by the payment itself.
 */
export const fxModule: AppModule = {
  id: 'fx',
  dependsOn: ['ledger'],
  permissions: ['fx.rates.write', 'fx.revaluations.read', 'fx.revaluations.post'],
  apps: [{ id: 'fx', order: 12, permissions: ['fx'] }],
  roles: [{ id: 'treasurer', permissions: ['fx.*', 'treasury.*', 'gl.reports.read'] }],
  migrations: [
    {
      id: '001_fx',
      up: `
        CREATE TABLE currencies (
          code       TEXT PRIMARY KEY CHECK (length(code) = 3),
          name_en    TEXT NOT NULL,
          name_ar    TEXT NOT NULL,
          symbol     TEXT,
          is_active  INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        -- Base-currency units per one foreign unit, × 1,000,000.
        CREATE TABLE exchange_rates (
          id         INTEGER PRIMARY KEY,
          currency   TEXT NOT NULL REFERENCES currencies(code),
          date       TEXT NOT NULL,
          rate       INTEGER NOT NULL CHECK (rate > 0),
          created_by INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE (currency, date)
        );
        CREATE TABLE fx_revaluations (
          id                INTEGER PRIMARY KEY,
          date              TEXT NOT NULL UNIQUE,
          entry_id          INTEGER REFERENCES journal_entries(id),
          reversal_entry_id INTEGER REFERENCES journal_entries(id),
          details           TEXT NOT NULL,
          created_by        INTEGER,
          created_at        TEXT NOT NULL
        );
      `,
    },
  ],

  setup(ctx) {
    ctx.services.provide('fx', createFx(ctx));
    const seed = () => {
      for (const [code, en, ar, sym] of SEED) {
        ctx.db.run('INSERT OR IGNORE INTO currencies (code, name_en, name_ar, symbol, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)', [code, en, ar, sym, nowIso()]);
      }
    };
    ctx.events.on('system.setup', seed);
    if (ctx.services.get('settings').isSetupComplete()) ctx.db.tx(seed);
  },

  health({ db }) {
    // Every foreign document must carry a rate, and every foreign line of the ledger a currency that exists.
    const unknown = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM journal_lines l WHERE l.currency IS NOT NULL AND NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = l.currency)`,
    )!.n;
    return [{ id: 'currencies', ok: unknown === 0, details: { count: unknown } }];
  },

  routes(r, { db, services, apps }) {
    const fx = services.get('fx');
    const ledger = services.get('ledger');
    const audit = services.get('audit');

    // ------------------------------------------------------------ currencies
    r.get('/currencies', 'auth', () => {
      assertApp(apps, 'fx');
      return db.all(
        `SELECT c.*, (SELECT rate FROM exchange_rates x WHERE x.currency = c.code ORDER BY date DESC LIMIT 1) AS last_rate,
                (SELECT date FROM exchange_rates x WHERE x.currency = c.code ORDER BY date DESC LIMIT 1) AS last_rate_date
         FROM currencies c WHERE c.code <> ? ORDER BY c.is_active DESC, c.code`,
        [fx.base()],
      );
    });

    const zCurrency = z.object({ code: zCode, nameEn: z.string().trim().min(1).max(60), nameAr: z.string().trim().min(1).max(60), symbol: z.string().trim().max(6).nullish(), isActive: z.boolean().default(true) });
    r.post('/currencies', 'fx.rates.write', ({ body, user }) => {
      const c = parse(zCurrency, body);
      if (c.code === fx.base()) fail('fx.base_currency', 'This is the company currency');
      if (db.get('SELECT 1 FROM currencies WHERE code = ?', [c.code])) conflict('fx.duplicate', `${c.code} already exists`);
      db.tx(() => {
        db.run('INSERT INTO currencies (code, name_en, name_ar, symbol, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)', [c.code, c.nameEn, c.nameAr, c.symbol ?? null, c.isActive ? 1 : 0, nowIso()]);
        audit.log({ userId: user.id, action: 'create', entity: 'currency', summary: c.code });
      });
      return { code: c.code };
    });

    r.put('/currencies/:code', 'fx.rates.write', ({ params, body, user }) => {
      const code = params.code.toUpperCase();
      const c = parse(zCurrency.omit({ code: true }), body);
      if (!db.get('SELECT 1 FROM currencies WHERE code = ?', [code])) notFound('currency', code);
      if (!c.isActive) {
        // Switching off a currency still in use would strand open documents and foreign accounts.
        const open =
          db.get(`SELECT 1 FROM documents WHERE currency = ? AND status = 'posted' AND amount_settled < total LIMIT 1`, [code]) ??
          db.get('SELECT 1 FROM accounts WHERE currency = ? AND is_active = 1 LIMIT 1', [code]);
        if (open) conflict('fx.in_use', `${code} still has open documents or active accounts`, { currency: code });
      }
      db.tx(() => {
        db.run('UPDATE currencies SET name_en = ?, name_ar = ?, symbol = ?, is_active = ? WHERE code = ?', [c.nameEn, c.nameAr, c.symbol ?? null, c.isActive ? 1 : 0, code]);
        audit.log({ userId: user.id, action: 'update', entity: 'currency', summary: code });
      });
      return { ok: true };
    });

    // ----------------------------------------------------------------- rates
    r.get('/fx/rates', 'auth', ({ query }) => {
      assertApp(apps, 'fx');
      const { currency } = parse(z.object({ currency: zCode }), query);
      return db.all('SELECT id, currency, date, rate FROM exchange_rates WHERE currency = ? ORDER BY date DESC LIMIT 400', [currency]);
    });

    /** The rate a document of that date would use. */
    r.get('/fx/rate', 'auth', ({ query }) => {
      assertApp(apps, 'fx');
      const q = parse(z.object({ currency: zCode, date: zDate.default(today()) }), query);
      if (!fx.isForeign(q.currency)) return { currency: q.currency, rate: 1_000_000, date: q.date };
      const row = db.get<{ rate: number; date: string }>('SELECT rate, date FROM exchange_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1', [q.currency, q.date]);
      return { currency: q.currency, rate: row?.rate ?? null, date: row?.date ?? null };
    });

    /** Enter or correct the rate of a day (one rate per currency per day). */
    r.post('/fx/rates', 'fx.rates.write', ({ body, user }) => {
      const q = parse(z.object({ currency: zCode, date: zDate, rate: zRate }), body);
      if (!fx.isForeign(q.currency)) fail('fx.base_currency', 'The company currency has no rate');
      fx.assertCurrency(q.currency);
      db.tx(() => {
        db.run(
          `INSERT INTO exchange_rates (currency, date, rate, created_by, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (currency, date) DO UPDATE SET rate = excluded.rate`,
          [q.currency, q.date, q.rate, user.id, nowIso()],
        );
        audit.log({ userId: user.id, action: 'update', entity: 'exchange_rate', summary: `${q.currency} ${q.date} ${q.rate / 1e6}` });
      });
      return { ok: true };
    });

    r.delete('/fx/rates/:id', 'fx.rates.write', ({ params, user }) => {
      const id = Number(params.id);
      db.tx(() => {
        db.run('DELETE FROM exchange_rates WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'exchange_rate', entityId: id });
      });
      return { ok: true };
    });

    // ---------------------------------------------------------- revaluation
    /**
     * What a revaluation on `date` would post: open foreign invoices/bills (receivable / payable)
     * and foreign cash/bank balances, re-measured at that date's rate.
     */
    const revaluation = (date: string) => {
      const docsOn = services.has('documents');
      const items: OpenItem[] = docsOn
        ? db.all<OpenItem>(
            `SELECT CASE WHEN d.kind IN ('sales_invoice', 'sales_credit') THEN 'receivable' ELSE 'payable' END AS side,
                    d.currency,
                    (CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN 1 ELSE -1 END) * (
                      d.total - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.document_id = d.id AND s.date <= :d), 0)
                              - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.source_type = 'credit' AND s.source_id = d.id AND s.date <= :d), 0)) AS fx,
                    (CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN 1 ELSE -1 END) * (
                      d.base_total - COALESCE((SELECT SUM(s.base_amount) FROM settlements s WHERE s.document_id = d.id AND s.date <= :d), 0)
                                   - COALESCE((SELECT SUM(s.source_base_amount) FROM settlements s WHERE s.source_type = 'credit' AND s.source_id = d.id AND s.date <= :d), 0)) AS carrying
             FROM documents d
             WHERE d.currency <> :base AND d.date <= :d
               AND (d.status = 'posted' OR (d.status = 'void' AND substr(d.voided_at, 1, 10) > :d))`,
            { d: date, base: fx.base() },
          )
        : [];
      const groups = new Map<string, { side: OpenItem['side']; currency: string; fx: number; carrying: number; revalued: number }>();
      for (const it of items) {
        if (it.fx === 0 && it.carrying === 0) continue;
        const k = `${it.side}:${it.currency}`;
        const g = groups.get(k) ?? { side: it.side, currency: it.currency, fx: 0, carrying: 0, revalued: 0 };
        g.fx += it.fx;
        g.carrying += it.carrying;
        g.revalued += fx.toBase(it.fx, fx.rate(it.currency, date));
        groups.set(k, g);
      }
      const cash = db
        .all<{ id: number; code: string; name_en: string; name_ar: string; currency: string; fx: number; carrying: number }>(
          `SELECT a.id, a.code, a.name_en, a.name_ar, a.currency,
                  COALESCE((SELECT SUM(l.amount_fx) FROM ledger l WHERE l.account_id = a.id AND l.date <= :d), 0) AS fx,
                  COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger l WHERE l.account_id = a.id AND l.date <= :d), 0) AS carrying
           FROM accounts a WHERE a.currency IS NOT NULL AND a.is_group = 0`,
          { d: date },
        )
        .map((a) => ({ ...a, rate: fx.rate(a.currency, date), revalued: 0 }))
        .map((a) => ({ ...a, revalued: fx.toBase(a.fx, a.rate) }))
        .filter((a) => a.revalued !== a.carrying);
      const open = [...groups.values()].map((g) => ({ ...g, rate: fx.rate(g.currency, date), difference: g.side === 'receivable' ? g.revalued - g.carrying : -(g.revalued - g.carrying) }));
      // difference > 0 is a gain for the company in both cases.
      const gain = open.reduce((s, g) => s + g.difference, 0) + cash.reduce((s, a) => s + a.revalued - a.carrying, 0);
      return { date, open, cash: cash.map((a) => ({ ...a, difference: a.revalued - a.carrying })), net: gain };
    };

    r.get('/fx/revaluations', 'fx.revaluations.read', () =>
      db.all(
        `SELECT v.*, e.number AS entry_number, x.number AS reversal_number
         FROM fx_revaluations v LEFT JOIN journal_entries e ON e.id = v.entry_id LEFT JOIN journal_entries x ON x.id = v.reversal_entry_id
         ORDER BY v.date DESC`,
      ).map((v: any) => ({ ...v, details: JSON.parse(v.details) })),
    );

    r.get('/fx/revaluations/preview', 'fx.revaluations.read', ({ query }) => revaluation(parse(z.object({ date: zDate }), query).date));

    r.post('/fx/revaluations', 'fx.revaluations.post', ({ body, user }) => {
      const { date } = parse(z.object({ date: zDate }), body);
      if (db.get('SELECT 1 FROM fx_revaluations WHERE date = ?', [date])) conflict('fx.already_revalued', `A revaluation on ${date} already exists`, { date });
      const rv = revaluation(date);
      const lines: JournalLineInput[] = [];
      const dr = (accountId: number, amt: number, extra: Partial<JournalLineInput> = {}) =>
        amt > 0 ? lines.push({ accountId, debit: amt, credit: 0, ...extra }) : amt < 0 && lines.push({ accountId, debit: 0, credit: -amt, ...extra });
      for (const g of rv.open) {
        if (!g.difference) continue;
        if (g.side === 'receivable') dr(ledger.ensureDefaultAccount('fxRevalReceivable', ON_DEMAND.fxRevalReceivable), g.difference, { description: `${g.currency} receivables` });
        else dr(ledger.ensureDefaultAccount('fxRevalPayable', ON_DEMAND.fxRevalPayable), g.difference, { description: `${g.currency} payables` });
      }
      for (const a of rv.cash) dr(a.id, a.difference, { currency: a.currency, amountFx: 0, description: `${a.currency} at ${a.rate / 1e6}` });
      if (rv.net > 0) dr(ledger.ensureDefaultAccount('fxGain', ON_DEMAND.fxGain), -rv.net);
      if (rv.net < 0) dr(ledger.ensureDefaultAccount('fxLoss', ON_DEMAND.fxLoss), -rv.net);
      if (lines.length < 2) fail('fx.nothing_to_revalue', 'Nothing is open in a foreign currency, or the rates have not moved');
      // The reversal lands on the next day, which must be an open period too.
      ledger.assertPostingDate(addDays(date, 1));
      return db.tx(() => {
        const entryId = ledger.createEntry({ date, reference: `FX ${date}`, memo: `Exchange revaluation ${date}`, lines }, { sourceType: 'fx_revaluation', sourceId: null, userId: user.id });
        const reversal = ledger.reverseEntry(entryId, { date: addDays(date, 1), memo: `Reversal of exchange revaluation ${date}`, sourceType: 'fx_revaluation' }, user.id);
        const id = db.insert('fx_revaluations', { date, entry_id: entryId, reversal_entry_id: reversal, details: JSON.stringify(rv), created_by: user.id, created_at: nowIso() });
        audit.log({ userId: user.id, action: 'post', entity: 'fx_revaluation', entityId: id, summary: date });
        return { id, entryId, reversalId: reversal, net: rv.net };
      });
    });

  },
};
