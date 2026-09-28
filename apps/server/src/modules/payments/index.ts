import { z } from 'zod';
import type { AppModule, ModuleContext, SessionUser } from '../../kernel/modules.js';
import { conflict, fail, forbidden, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { fxToBase, sum } from '../../kernel/money.js';
import { ON_DEMAND } from '../ledger/chart-template.js';
import type {} from '../../contracts/fx.js';
import { paging, parse, zDate, zId, zOptId, zOptText, zPositiveMinor } from '../../kernel/validate.js';
import type { JournalLineInput } from '../ledger/service.js';
import type { DocKind } from '../../contracts/documents.js';
import type { WhtType } from '../../contracts/tax.js';

export type Direction = 'in' | 'out';
export type PartyRole = 'customer' | 'supplier';

export interface Payment {
  id: number;
  direction: Direction;
  number: string | null;
  date: string;
  party_id: number | null;
  party_role: PartyRole | null;
  account_id: number;
  counter_account_id: number | null;
  amount: number;
  /** Payment currency (null = the company's) and base units per one unit × 1,000,000. */
  currency: string | null;
  exchange_rate: number;
  base_amount: number;
  /** Egypt withholding (خصم وإضافة): deducted from (out) or by (in) the party, on the value before VAT. */
  wht_type: string | null;
  wht_base: number;
  wht_rate_bp: number;
  wht_amount: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
  journal_entry_id: number | null;
  void_entry_id: number | null;
  created_at: string;
}

export interface PaymentInput {
  direction: Direction;
  date: string;
  partyId: number | null;
  partyRole: PartyRole | null;
  accountId: number;
  counterAccountId: number | null;
  amount: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  currency?: string | null;
  exchangeRate?: number | null;
  /** Withholding: its type and the value before VAT it applies to; the rate comes from the tax settings. */
  withholding?: { type: WhtType; base: number } | null;
  allocations: { documentId: number; amount: number }[];
}

/** Which document kind a payment can settle. */
export function settlesKind(direction: Direction, role: PartyRole): DocKind {
  if (direction === 'in') return role === 'customer' ? 'sales_invoice' : 'purchase_credit';
  return role === 'supplier' ? 'purchase_bill' : 'sales_credit';
}

const SEQ: Record<Direction, [string, string]> = { in: ['receipt', 'RCT-'], out: ['payment', 'PAY-'] };

export type PaymentsService = ReturnType<typeof createPayments>;

declare module '../../kernel/services.js' {
  interface ServiceMap {
    payments: PaymentsService;
  }
}

function createPayments({ db, services, events, apps }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const docs = () => services.get('documents');
  const parties = () => services.get('parties');
  const audit = () => services.get('audit');

  const get = (id: number): Payment => db.get<Payment>('SELECT * FROM payments WHERE id = ?', [id]) ?? notFound('payment', id);
  const baseCurrency = () => services.get('settings').company().baseCurrency;

  /** Currency (null = base) and rate of a payment. */
  function currencyOf(input: PaymentInput): { currency: string | null; rate: number } {
    const code = input.currency && input.currency !== baseCurrency() ? input.currency : null;
    if (!code) return { currency: null, rate: 1_000_000 };
    if (!services.has('fx') || !apps.isEnabled('fx')) fail('fx.unavailable', 'Multi-currency is switched off');
    const fx = services.get('fx');
    fx.assertCurrency(code);
    const rate = input.exchangeRate ?? fx.rate(code, input.date);
    if (!Number.isSafeInteger(rate) || rate <= 0) fail('fx.invalid_rate', 'Invalid exchange rate');
    return { currency: code, rate };
  }

  /** The withholding of a payment: type, base, the rate in force and the amount (null = none). */
  function withholdingOf(input: PaymentInput): { type: WhtType; base: number; rateBp: number; amount: number } | null {
    const w = input.withholding;
    if (!w || w.base <= 0) return null;
    if (!services.has('tax')) fail('wht.unavailable', 'Withholding needs the Tax app');
    const rateBp = services.get('tax').withholding().rates[w.type];
    const amount = Math.round((w.base * rateBp) / 10000);
    return amount > 0 ? { type: w.type, base: w.base, rateBp, amount } : null;
  }

  /**
   * Withholding a payment would carry: the party's type and the value before VAT of the invoices it
   * settles (each allocation × net ÷ total). Nothing below the minimum or when the company is not an agent.
   */
  function suggestWithholding(input: { partyId: number; direction: Direction; allocations: { documentId: number; amount: number }[] }) {
    if (!services.has('tax')) return null;
    const party = parties().get(input.partyId);
    const settings = services.get('tax').withholding();
    if (!party.wht_type || (input.direction === 'out' && !settings.agent)) return null;
    const base = input.allocations.reduce((s, a) => {
      const d = docs().get(a.documentId);
      return s + (d.total ? Math.round((a.amount * d.subtotal) / d.total) : 0);
    }, 0);
    const type = party.wht_type as WhtType;
    const rateBp = settings.rates[type];
    const below = base < settings.minBase;
    return { type, rateBp, base, amount: below ? 0 : Math.round((base * rateBp) / 10000), belowMinimum: below, minBase: settings.minBase };
  }

  function validate(input: PaymentInput, selfId: number | null): void {
    const acc = ledger().account(input.accountId);
    const { currency } = currencyOf(input);
    // A foreign-currency bank account only moves its own currency.
    if (acc.currency && acc.currency !== currency) fail('fx.account_currency', `${acc.code} is kept in ${acc.currency}`, { code: acc.code, currency: acc.currency });
    if (acc.subtype !== 'cash' && acc.subtype !== 'bank') fail('payment.account_not_cash', 'Choose a cash or bank account');
    if (!acc.is_active) fail('payment.account_inactive', `${acc.code} is inactive`);
    if (input.partyId) {
      const party = parties().get(input.partyId);
      // A party that is only a customer (or only a supplier) needs no role; "both" must say which.
      if (!input.partyRole && party.kind !== 'both') input.partyRole = party.kind as PartyRole;
      if (!input.partyRole) fail('payment.role_required', 'Specify whether the party is a customer or a supplier');
      parties().assertKind(party, input.partyRole!);
      if (input.counterAccountId) fail('payment.party_or_account', 'Choose either a party or a counter account');
    } else {
      if (!input.counterAccountId) fail('payment.party_or_account', 'Choose a party or a counter account');
      const c = ledger().account(input.counterAccountId!);
      if (c.is_group || !c.is_active) fail('payment.counter_invalid', `${c.code} cannot be used`);
      if (c.subtype === 'receivable' || c.subtype === 'payable') {
        fail('payment.counter_control', 'Use a party for receivable/payable accounts');
      }
      if (c.id === acc.id) fail('payment.same_account', 'The counter account must differ from the cash/bank account');
      if (input.allocations.length) fail('payment.alloc_without_party', 'Allocations need a party');
    }
    const wht = withholdingOf(input);
    if (wht) {
      if (!input.partyId) fail('wht.party_required', 'Withholding needs a customer or supplier');
      if (currency) fail('wht.currency', 'Withholding is in the company currency only');
      const expected = input.direction === 'out' ? 'supplier' : 'customer';
      if (input.partyRole !== expected) fail('wht.direction', 'Tax is withheld from payments to suppliers, or by customers from their payments');
    }
    // The party is settled by the cash plus the tax withheld.
    const settled = input.amount + (wht?.amount ?? 0);
    const allocated = sum(input.allocations.map((a) => a.amount));
    if (allocated > settled) fail('payment.over_allocated', 'Allocated more than the payment amount', { allocated, amount: settled });
    const seen = new Set<number>();
    for (const a of input.allocations) {
      if (seen.has(a.documentId)) fail('payment.duplicate_allocation', 'A document appears twice');
      seen.add(a.documentId);
      const d = docs().get(a.documentId);
      const kind = settlesKind(input.direction, input.partyRole!);
      if (d.kind !== kind || d.party_id !== input.partyId || d.status !== 'posted') {
        fail('payment.bad_allocation', `${d.number ?? 'Document'} cannot be settled by this payment`);
      }
      if ((d.currency === baseCurrency() ? null : d.currency) !== currency) {
        fail('fx.currency_mismatch', `${d.number} is in ${d.currency} — the payment must be too`, { number: d.number, currency: d.currency });
      }
      if (a.amount > d.total - d.amount_settled) {
        fail('settlement.exceeds', `Amount exceeds what is outstanding on ${d.number}`, {
          number: d.number,
          outstanding: d.total - d.amount_settled,
        });
      }
    }
    void selfId;
  }

  function write(id: number | null, input: PaymentInput, userId: number | null): number {
    validate(input, id);
    const { currency, rate } = currencyOf(input);
    const row = {
      direction: input.direction,
      date: input.date,
      party_id: input.partyId,
      party_role: input.partyId ? input.partyRole : null,
      account_id: input.accountId,
      counter_account_id: input.partyId ? null : input.counterAccountId,
      amount: input.amount,
      currency,
      exchange_rate: rate,
      base_amount: fxToBase(input.amount, rate),
      ...(() => {
        const w = withholdingOf(input);
        return { wht_type: w?.type ?? null, wht_base: w?.base ?? 0, wht_rate_bp: w?.rateBp ?? 0, wht_amount: w?.amount ?? 0 };
      })(),
      method: input.method,
      reference: input.reference,
      memo: input.memo,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let pid = id;
      if (pid == null) {
        pid = db.insert('payments', { ...row, status: 'draft', created_by: userId, created_at: nowIso() });
      } else {
        db.update('payments', pid, row);
        db.run('DELETE FROM payment_allocations WHERE payment_id = ?', [pid]);
      }
      for (const a of input.allocations) db.insert('payment_allocations', { payment_id: pid, document_id: a.documentId, amount: a.amount });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'payment', entityId: pid });
      return pid;
    });
  }

  function allocations(id: number): { document_id: number; amount: number }[] {
    return db.all('SELECT document_id, amount FROM payment_allocations WHERE payment_id = ?', [id]);
  }

  function post(id: number, userId: number | null): void {
    const p = get(id);
    if (p.status !== 'draft') conflict('payment.not_draft', 'Payment is already posted');
    const allocs = allocations(id);
    validate(
      {
        direction: p.direction,
        date: p.date,
        partyId: p.party_id,
        partyRole: p.party_role,
        accountId: p.account_id,
        counterAccountId: p.counter_account_id,
        amount: p.amount,
        method: p.method,
        reference: p.reference,
        memo: p.memo,
        currency: p.currency,
        exchangeRate: p.exchange_rate,
        withholding: p.wht_amount ? { type: p.wht_type as WhtType, base: p.wht_base } : null,
        allocations: allocs.map((a) => ({ documentId: a.document_id, amount: a.amount })),
      },
      id,
    );
    // The rate may have changed since the draft was saved: the draft's own amount is what is booked.
    const wht = p.wht_amount;
    const party = p.party_id ? parties().get(p.party_id) : null;
    const other = party
      ? p.party_role === 'customer'
        ? parties().receivableAccount(party)
        : parties().payableAccount(party)
      : p.counter_account_id!;
    const dirIn = p.direction === 'in';
    const fxInfo = (amt: number) => (p.currency ? { currency: p.currency, amountFx: amt } : {});
    // Cash moves at today's rate.
    const cashBase = p.base_amount;
    const cashLine: JournalLineInput = { accountId: p.account_id, debit: dirIn ? cashBase : 0, credit: dirIn ? 0 : cashBase, ...fxInfo(dirIn ? p.amount : -p.amount) };
    // The party side leaves at the value each invoice was booked at; what is not applied stays on account at today's rate.
    const allocated = sum(allocs.map((a) => a.amount));
    const partyBase =
      allocs.reduce((s, a) => s + docs().baseFor(docs().get(a.document_id), a.amount), 0) + fxToBase(p.amount + wht - allocated, p.exchange_rate);
    const otherLine: JournalLineInput = {
      accountId: other,
      partyId: party?.id ?? null,
      debit: dirIn ? 0 : party ? partyBase : cashBase,
      credit: dirIn ? (party ? partyBase : cashBase) : 0,
      description: party?.name ?? p.memo,
      ...(party ? fxInfo(dirIn ? -p.amount : p.amount) : {}),
    };
    // Realised exchange difference (IAS 21 §28): cash received above the booked value is a gain.
    const lines: JournalLineInput[] = dirIn ? [cashLine, otherLine] : [otherLine, cashLine];
    // Withholding: by the customer, an advance on the company's income tax (asset); from the supplier, due to the Tax Authority.
    if (wht) {
      const key = dirIn ? 'whtReceivable' : 'whtPayable';
      const whtLine: JournalLineInput = { accountId: ledger().ensureDefaultAccount(key, ON_DEMAND[key]), debit: dirIn ? wht : 0, credit: dirIn ? 0 : wht, description: `Withholding tax ${p.wht_rate_bp / 100}%` };
      lines.splice(1, 0, whtLine);
    }
    const diff = party ? (dirIn ? cashBase + wht - partyBase : partyBase - cashBase - wht) : 0;
    if (diff > 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxGain', ON_DEMAND.fxGain), debit: 0, credit: diff, description: 'Exchange gain' });
    if (diff < 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxLoss', ON_DEMAND.fxLoss), debit: -diff, credit: 0, description: 'Exchange loss' });
    db.tx(() => {
      const number = services.get('sequences').next(SEQ[p.direction][0]);
      const entryId = ledger().createEntry(
        {
          date: p.date,
          reference: p.reference ? `${number} / ${p.reference}` : number,
          memo: p.memo ?? (party ? `${number} — ${party.name}` : number),
          lines,
        },
        { sourceType: p.direction === 'in' ? 'receipt' : 'payment', sourceId: p.id, userId },
      );
      db.run(`UPDATE payments SET status = 'posted', number = ?, journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [
        number,
        entryId,
        nowIso(),
        nowIso(),
        id,
      ]);
      for (const a of allocs) {
        docs().settle(a.document_id, { sourceType: 'payment', sourceId: id, sourceNumber: number, amount: a.amount, date: p.date });
      }
      audit().log({ userId, action: 'post', entity: 'payment', entityId: id, summary: number });
      events.emit('payment.posted', { paymentId: id });
    });
  }

  function voidPayment(id: number, opts: { date?: string | null }, userId: number | null): void {
    const p = get(id);
    if (p.status !== 'posted') conflict('payment.not_posted', 'Only posted payments can be voided');
    db.tx(() => {
      docs().unsettleSource('payment', id);
      const revId = ledger().reverseEntry(p.journal_entry_id!, { date: opts.date ?? p.date, memo: `Void ${p.number}` }, userId);
      db.run(`UPDATE payments SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [revId, nowIso(), nowIso(), id]);
      audit().log({ userId, action: 'void', entity: 'payment', entityId: id, summary: p.number });
      events.emit('payment.voided', { paymentId: id });
    });
  }

  function remove(id: number, userId: number | null): void {
    const p = get(id);
    if (p.status !== 'draft') conflict('payment.not_draft', 'Only drafts can be deleted — void posted payments');
    db.tx(() => {
      db.run('DELETE FROM payments WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'payment', entityId: id });
    });
  }

  return {
    get,
    allocations,
    suggestWithholding,
    create: (input: PaymentInput, userId: number | null) => write(null, input, userId),
    update(id: number, input: PaymentInput, userId: number | null) {
      const p = get(id);
      if (p.status !== 'draft') conflict('payment.not_draft', 'Only drafts can be edited');
      if (p.direction !== input.direction) fail('payment.direction_locked', 'Direction cannot change');
      write(id, input, userId);
    },
    post,
    void: voidPayment,
    remove,
  };
}

const zPayment = z.object({
  direction: z.enum(['in', 'out']),
  date: zDate,
  partyId: zOptId.transform((v) => v ?? null),
  partyRole: z.enum(['customer', 'supplier']).nullish().transform((v) => v ?? null),
  accountId: zId,
  counterAccountId: zOptId.transform((v) => v ?? null),
  amount: zPositiveMinor,
  method: z.enum(['cash', 'bank_transfer', 'cheque', 'card', 'other']).nullish().transform((v) => v ?? null),
  reference: zOptText(100),
  memo: zOptText(1000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null),
  allocations: z.array(z.object({ documentId: zId, amount: zPositiveMinor })).max(500).default([]),
  withholding: z
    .object({ type: z.enum(['supplies', 'contracting', 'services', 'commissions']), base: z.number().int().min(0).max(1e15) })
    .nullish()
    .transform((v) => v ?? null),
  post: z.boolean().default(false),
});

export const paymentsModule: AppModule = {
  id: 'payments',
  dependsOn: ['ledger', 'parties', 'documents'],
  permissions: [
    'treasury.receipts.read',
    'treasury.receipts.write',
    'treasury.receipts.post',
    'treasury.payments.read',
    'treasury.payments.write',
    'treasury.payments.post',
  ],
  apps: [{ id: 'treasury', order: 30, permissions: ['treasury'] }],
  roles: [{ id: 'cashier', permissions: ['treasury.*', 'ar.customers.read', 'ap.suppliers.read', 'ar.invoices.read', 'ap.bills.read'] }],
  sod: [
    ['ap.suppliers.write', 'treasury.payments.post'],
    ['ar.customers.write', 'treasury.receipts.post'],
  ],
  health({ db }) {
    const over = db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM payments p WHERE (SELECT COALESCE(SUM(amount), 0) FROM payment_allocations a WHERE a.payment_id = p.id) > p.amount',
    )!.n;
    return [{ id: 'allocated', ok: over === 0, details: { count: over } }];
  },
  migrations: [
    {
      id: '001_payments',
      up: `
        CREATE TABLE payments (
          id                 INTEGER PRIMARY KEY,
          direction          TEXT NOT NULL CHECK (direction IN ('in', 'out')),   -- receipt / payment
          number             TEXT,
          date               TEXT NOT NULL,
          party_id           INTEGER REFERENCES parties(id),
          party_role         TEXT CHECK (party_role IN ('customer', 'supplier')),
          account_id         INTEGER NOT NULL REFERENCES accounts(id),           -- cash / bank
          counter_account_id INTEGER REFERENCES accounts(id),                    -- direct income/expense when no party
          amount             INTEGER NOT NULL CHECK (amount > 0),
          method             TEXT,
          reference          TEXT,
          memo               TEXT,
          status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
          journal_entry_id   INTEGER REFERENCES journal_entries(id),
          void_entry_id      INTEGER REFERENCES journal_entries(id),
          created_by         INTEGER REFERENCES users(id),
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          posted_at          TEXT,
          voided_at          TEXT,
          UNIQUE (direction, number),
          CHECK ((party_id IS NULL) <> (counter_account_id IS NULL))
        );
        CREATE INDEX payments_dir ON payments(direction, status, date);
        CREATE INDEX payments_party ON payments(party_id);

        CREATE TABLE payment_allocations (
          payment_id  INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
          document_id INTEGER NOT NULL REFERENCES documents(id),
          amount      INTEGER NOT NULL CHECK (amount > 0),
          PRIMARY KEY (payment_id, document_id)
        );

        CREATE TRIGGER payments_posted_frozen BEFORE UPDATE ON payments
        WHEN OLD.status <> 'draft' AND (
             NEW.amount IS NOT OLD.amount OR NEW.date IS NOT OLD.date OR NEW.party_id IS NOT OLD.party_id
          OR NEW.account_id IS NOT OLD.account_id OR NEW.number IS NOT OLD.number OR OLD.status = 'void')
        BEGIN SELECT RAISE(ABORT, 'payments: posted payments are frozen'); END;

        CREATE TRIGGER payments_posted_no_delete BEFORE DELETE ON payments
        WHEN OLD.status <> 'draft'
        BEGIN SELECT RAISE(ABORT, 'payments: posted payments cannot be deleted'); END;
      `,
    },
    {
      // Multi-currency: the amount is in the payment currency (null = base); base_amount is what the cash moved in base.
      id: '002_currency',
      up: `
        ALTER TABLE payments ADD COLUMN currency TEXT;
        ALTER TABLE payments ADD COLUMN exchange_rate INTEGER NOT NULL DEFAULT 1000000 CHECK (exchange_rate > 0);
        ALTER TABLE payments ADD COLUMN base_amount INTEGER NOT NULL DEFAULT 0;
        DROP TRIGGER payments_posted_frozen;
        UPDATE payments SET base_amount = amount;
        CREATE TRIGGER payments_posted_frozen BEFORE UPDATE ON payments
        WHEN OLD.status <> 'draft' AND (
             NEW.amount IS NOT OLD.amount OR NEW.date IS NOT OLD.date OR NEW.party_id IS NOT OLD.party_id
          OR NEW.account_id IS NOT OLD.account_id OR NEW.number IS NOT OLD.number
          OR NEW.currency IS NOT OLD.currency OR NEW.exchange_rate IS NOT OLD.exchange_rate OR NEW.base_amount IS NOT OLD.base_amount
          OR OLD.status = 'void')
        BEGIN SELECT RAISE(ABORT, 'payments: posted payments are frozen'); END;
      `,
    },
    {
      // Egypt withholding (خصم وإضافة): the type, base, rate and amount deducted on the payment.
      id: '003_withholding',
      up: `
        ALTER TABLE payments ADD COLUMN wht_type TEXT CHECK (wht_type IS NULL OR wht_type IN ('supplies', 'contracting', 'services', 'commissions'));
        ALTER TABLE payments ADD COLUMN wht_base INTEGER NOT NULL DEFAULT 0 CHECK (wht_base >= 0);
        ALTER TABLE payments ADD COLUMN wht_rate_bp INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE payments ADD COLUMN wht_amount INTEGER NOT NULL DEFAULT 0 CHECK (wht_amount >= 0);
        DROP TRIGGER payments_posted_frozen;
        CREATE TRIGGER payments_posted_frozen BEFORE UPDATE ON payments
        WHEN OLD.status <> 'draft' AND (
             NEW.amount IS NOT OLD.amount OR NEW.date IS NOT OLD.date OR NEW.party_id IS NOT OLD.party_id
          OR NEW.account_id IS NOT OLD.account_id OR NEW.number IS NOT OLD.number
          OR NEW.currency IS NOT OLD.currency OR NEW.exchange_rate IS NOT OLD.exchange_rate OR NEW.base_amount IS NOT OLD.base_amount
          OR NEW.wht_amount IS NOT OLD.wht_amount OR NEW.wht_base IS NOT OLD.wht_base
          OR OLD.status = 'void')
        BEGIN SELECT RAISE(ABORT, 'payments: posted payments are frozen'); END;
      `,
    },
  ],

  setup(ctx) {
    ctx.services.provide('payments', createPayments(ctx));
    ctx.events.on('system.setup', () => {
      const seq = ctx.services.get('sequences');
      seq.ensure(SEQ.in[0], SEQ.in[1], 5);
      seq.ensure(SEQ.out[0], SEQ.out[1], 5);
    });
  },

  routes(r, { db, services }) {
    const payments = services.get('payments');

    /** Receipts (money in) and payments (money out) are separate pages with separate rights. */
    const permOf = (d: Direction, action: 'read' | 'write' | 'post') => `treasury.${d === 'in' ? 'receipts' : 'payments'}.${action}`;
    const need = (user: SessionUser, d: Direction, action: 'read' | 'write' | 'post') => {
      if (!user.permissions.has(permOf(d, action))) forbidden(permOf(d, action));
    };
    const needAny = (user: SessionUser) => {
      if (!user.permissions.has(permOf('in', 'read')) && !user.permissions.has(permOf('out', 'read'))) forbidden(permOf('in', 'read'));
    };

    /** Cash & bank accounts with their current balances. */
    r.get('/payments/accounts', 'auth', ({ user }) => (needAny(user),
      db.all(
        `SELECT a.id, a.code, a.name_en, a.name_ar, a.subtype, a.is_active, a.currency,
                COALESCE((SELECT SUM(debit - credit) FROM ledger l WHERE l.account_id = a.id), 0) AS balance,
                COALESCE((SELECT SUM(amount_fx) FROM ledger l WHERE l.account_id = a.id), 0) AS balance_fx
         FROM accounts a WHERE a.subtype IN ('cash', 'bank') AND a.is_group = 0 ORDER BY a.code`,
      )),
    );

    /** Documents a payment can be allocated to. */
    r.get('/payments/open-documents', 'auth', ({ query, user }) => {
      const q = parse(z.object({ partyId: zId, direction: z.enum(['in', 'out']), role: z.enum(['customer', 'supplier']) }), query);
      need(user, q.direction, 'read');
      return db.all(
        `SELECT id, kind, number, date, due_date, total, amount_settled, total - amount_settled AS outstanding, currency
         FROM documents WHERE party_id = ? AND kind = ? AND status = 'posted' AND amount_settled < total
         ORDER BY due_date, id`,
        [q.partyId, settlesKind(q.direction, q.role)],
      );
    });

    r.get('/payments', 'auth', ({ query, user }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.direction === 'in' || query.direction === 'out') {
        need(user, query.direction, 'read');
        where.push('p.direction = :dir');
        p.dir = query.direction;
      } else {
        needAny(user);
        const dirs = (['in', 'out'] as const).filter((d) => user.permissions.has(permOf(d, 'read')));
        if (dirs.length === 1) (where.push('p.direction = :dir'), (p.dir = dirs[0]));
      }
      if (query.status) (where.push('p.status = :status'), (p.status = query.status));
      if (query.partyId) (where.push('p.party_id = :party'), (p.party = Number(query.partyId)));
      if (query.accountId) (where.push('p.account_id = :acc'), (p.acc = Number(query.accountId)));
      if (query.from) (where.push('p.date >= :from'), (p.from = query.from));
      if (query.to) (where.push('p.date <= :to'), (p.to = query.to));
      if (query.q) {
        where.push('(p.number LIKE :q OR p.reference LIKE :q OR p.memo LIKE :q OR pa.name LIKE :q)');
        p.q = `%${query.q}%`;
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const from = `FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id
                    JOIN accounts a ON a.id = p.account_id LEFT JOIN accounts c ON c.id = p.counter_account_id`;
      const rows = db.all(
        `SELECT p.*, pa.name AS party_name, a.code AS account_code, a.name_en AS account_name_en, a.name_ar AS account_name_ar,
                c.code AS counter_code, c.name_en AS counter_name_en, c.name_ar AS counter_name_ar,
                (SELECT COALESCE(SUM(amount), 0) FROM payment_allocations x WHERE x.payment_id = p.id) AS allocated
         ${from} ${w} ORDER BY p.date DESC, p.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const agg = db.get<{ n: number; total: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN p.status = 'posted' THEN p.base_amount END), 0) total ${from} ${w}`,
        p,
      )!;
      return { rows, total: agg.n, sums: { total: agg.total } };
    });

    r.get('/payments/:id', 'auth', ({ params, user }) => {
      const p = payments.get(Number(params.id));
      need(user, p.direction, 'read');
      const allocations = db.all(
        `SELECT x.document_id, x.amount, d.number, d.kind, d.date, d.total, d.amount_settled
         FROM payment_allocations x JOIN documents d ON d.id = x.document_id WHERE x.payment_id = ?`,
        [p.id],
      );
      const party = p.party_id ? services.get('parties').get(p.party_id) : null;
      const je = (id: number | null) => (id ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [id])?.number : null);
      return {
        ...p,
        party,
        account: services.get('ledger').account(p.account_id),
        counter_account: p.counter_account_id ? services.get('ledger').account(p.counter_account_id) : null,
        allocations,
        journal_number: je(p.journal_entry_id),
        void_journal_number: je(p.void_entry_id),
      };
    });

    /** The withholding a payment should carry (the party's type, the invoices' value before VAT). */
    r.post('/payments/withholding', 'auth', ({ body, user }) => {
      const q = parse(z.object({ partyId: zId, direction: z.enum(['in', 'out']), allocations: z.array(z.object({ documentId: zId, amount: zPositiveMinor })).max(500).default([]) }), body);
      need(user, q.direction, 'write');
      return payments.suggestWithholding(q);
    });

    r.post('/payments', 'auth', ({ body, user }) => {
      const input = parse(zPayment, body);
      need(user, input.direction, 'write');
      if (input.post) need(user, input.direction, 'post');
      const id = db.tx(() => {
        const id = payments.create(input, user.id);
        if (input.post) payments.post(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/payments/:id', 'auth', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zPayment, body);
      need(user, payments.get(id).direction, 'write');
      need(user, input.direction, 'write');
      if (input.post) need(user, input.direction, 'post');
      db.tx(() => {
        payments.update(id, input, user.id);
        if (input.post) payments.post(id, user.id);
      });
      return { id };
    });

    r.post('/payments/:id/post', 'auth', ({ params, user }) => {
      need(user, payments.get(Number(params.id)).direction, 'post');
      payments.post(Number(params.id), user.id);
      return { ok: true };
    });

    r.post('/payments/:id/void', 'auth', ({ params, body, user }) => {
      need(user, payments.get(Number(params.id)).direction, 'post');
      const input = parse(z.object({ date: zDate.nullish() }), body ?? {});
      payments.void(Number(params.id), input, user.id);
      return { ok: true };
    });

    r.delete('/payments/:id', 'auth', ({ params, user }) => {
      need(user, payments.get(Number(params.id)).direction, 'write');
      payments.remove(Number(params.id), user.id);
      return { ok: true };
    });
  },
};
