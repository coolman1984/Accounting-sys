import { z } from 'zod';
import type { AppModule, ModuleContext, SessionUser } from '../../kernel/modules.js';
import { conflict, fail, forbidden, notFound } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText, zPositiveMinor } from '../../kernel/validate.js';

/**
 * Post-dated cheques, received from customers and issued to suppliers.
 *
 *   received:  in_hand → deposited → cleared        (or bounced / returned before clearing)
 *   issued:    issued → cleared                     (or cancelled before clearing)
 *
 * A cheque settles invoices (or bills) the day it changes hands; the money reaches the bank on
 * clearing. In between it sits in "Cheques receivable" (أوراق قبض) or "Cheques payable" (أوراق دفع).
 * A bounced, returned or cancelled cheque reopens the invoices it settled.
 */

type Direction = 'received' | 'issued';
type Status = 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'returned' | 'issued' | 'cancelled';

interface Cheque {
  id: number;
  direction: Direction;
  number: string;
  cheque_no: string;
  bank_name: string | null;
  party_id: number;
  amount: number;
  date: string;
  due_date: string;
  status: Status;
  bank_account_id: number | null;
  memo: string | null;
  entry_id: number | null;
  clear_entry_id: number | null;
  cancel_entry_id: number | null;
  deposited_date: string | null;
  cleared_date: string | null;
  cancelled_date: string | null;
  reason: string | null;
}

const OPEN: Status[] = ['in_hand', 'deposited', 'issued'];

function createCheques({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const docs = () => services.get('documents');
  const parties = () => services.get('parties');
  const audit = () => services.get('audit');
  const cheque = (id: number) => db.get<Cheque>('SELECT * FROM cheques WHERE id = ?', [id]) ?? notFound('cheque', id);
  const baseCurrency = () => services.get('settings').company().baseCurrency;

  function holdingAccount(direction: Direction): number {
    const key = direction === 'received' ? 'receivable_account_id' : 'payable_account_id';
    const cur = db.get<Record<string, number | null>>('SELECT * FROM cheque_settings WHERE id = 1')![key];
    if (cur) return cur;
    const id =
      direction === 'received'
        ? ledger().ensureAccount({ code: '1155', en: 'Cheques Receivable', ar: 'أوراق القبض', type: 'asset', subtype: 'current_asset', parentCode: '11' })
        : ledger().ensureAccount({ code: '2155', en: 'Cheques Payable', ar: 'أوراق الدفع', type: 'liability', subtype: 'current_liability', parentCode: '21' });
    db.run(`UPDATE cheque_settings SET ${key} = ? WHERE id = 1`, [id]);
    return id;
  }

  function bankAccount(id: number) {
    const a = ledger().account(id);
    if (a.subtype !== 'bank' && a.subtype !== 'cash') fail('cheque.bank_account', 'Choose a bank account');
    if (a.is_group || !a.is_active) fail('cheque.bank_account', `${a.code} cannot be used`);
    if (a.currency) fail('fx.account_currency', `${a.code} is kept in ${a.currency}`, { code: a.code, currency: a.currency });
    return a;
  }

  const zCheque = z.object({
    direction: z.enum(['received', 'issued']),
    chequeNo: z.string().trim().min(1).max(40),
    bankName: zOptText(100),
    partyId: zId,
    amount: zPositiveMinor,
    date: zDate,
    dueDate: zDate,
    /** Issued cheques: the account they are drawn on. Received: optional deposit account. */
    bankAccountId: zOptId.transform((v) => v ?? null),
    memo: zOptText(500),
    allocations: z.array(z.object({ documentId: zId, amount: zPositiveMinor })).max(200).default([]),
  });
  type ChequeInput = z.infer<typeof zCheque>;

  /** Record a cheque and book it: it settles the chosen invoices (or bills) at once. */
  function create(input: ChequeInput, userId: number | null): number {
    const party = parties().get(input.partyId);
    const role = input.direction === 'received' ? 'customer' : 'supplier';
    parties().assertKind(party, role);
    if (input.dueDate < input.date) fail('cheque.due_before', 'The due date cannot be before the cheque date');
    if (input.direction === 'issued' && !input.bankAccountId) fail('cheque.bank_account', 'Choose the bank account the cheque is drawn on');
    if (input.bankAccountId) bankAccount(input.bankAccountId);
    const kind = input.direction === 'received' ? 'sales_invoice' : 'purchase_bill';
    const allocated = input.allocations.reduce((s, a) => s + a.amount, 0);
    if (allocated > input.amount) fail('payment.over_allocated', 'Allocated more than the cheque amount', { allocated, amount: input.amount });
    const seen = new Set<number>();
    for (const a of input.allocations) {
      if (seen.has(a.documentId)) fail('payment.duplicate_allocation', 'A document appears twice');
      seen.add(a.documentId);
      const d = docs().get(a.documentId);
      if (d.kind !== kind || d.party_id !== party.id || d.status !== 'posted') fail('payment.bad_allocation', `${d.number ?? 'Document'} cannot be settled by this cheque`);
      if (d.currency !== baseCurrency()) fail('fx.currency_mismatch', `${d.number} is in ${d.currency} — cheques are in ${baseCurrency()}`, { number: d.number, currency: d.currency });
    }
    const dup = db.get('SELECT 1 FROM cheques WHERE direction = ? AND cheque_no = ? AND party_id = ? AND status NOT IN (?, ?, ?)', [input.direction, input.chequeNo, party.id, 'bounced', 'returned', 'cancelled']);
    if (dup) conflict('cheque.duplicate', 'This cheque number is already recorded for this party');
    const control = input.direction === 'received' ? parties().receivableAccount(party) : parties().payableAccount(party);
    const holding = holdingAccount(input.direction);
    return db.tx(() => {
      const number = services.get('sequences').next(input.direction === 'received' ? 'cheque_received' : 'cheque_issued');
      const id = db.insert('cheques', {
        direction: input.direction,
        number,
        cheque_no: input.chequeNo,
        bank_name: input.bankName,
        party_id: party.id,
        amount: input.amount,
        date: input.date,
        due_date: input.dueDate,
        status: input.direction === 'received' ? 'in_hand' : 'issued',
        bank_account_id: input.bankAccountId,
        memo: input.memo,
        created_by: userId,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      const received = input.direction === 'received';
      const entryId = ledger().createEntry(
        {
          date: input.date,
          reference: `${number} / ${input.chequeNo}`,
          memo: input.memo ?? `${number} — ${party.name}`,
          lines: [
            { accountId: holding, debit: received ? input.amount : 0, credit: received ? 0 : input.amount, description: `Cheque ${input.chequeNo}` },
            { accountId: control, partyId: party.id, debit: received ? 0 : input.amount, credit: received ? input.amount : 0, description: party.name },
          ],
        },
        { sourceType: received ? 'cheque_received' : 'cheque_issued', sourceId: id, userId },
      );
      db.run('UPDATE cheques SET entry_id = ? WHERE id = ?', [entryId, id]);
      for (const a of input.allocations) {
        db.insert('cheque_allocations', { cheque_id: id, document_id: a.documentId, amount: a.amount });
        docs().settle(a.documentId, { sourceType: 'cheque', sourceId: id, sourceNumber: number, amount: a.amount, date: input.date });
      }
      audit().log({ userId, action: 'post', entity: 'cheque', entityId: id, summary: `${number} ${input.chequeNo}` });
      return id;
    });
  }

  function deposit(id: number, input: { date: string; bankAccountId: number }, userId: number | null) {
    const c = cheque(id);
    if (c.direction !== 'received' || c.status !== 'in_hand') conflict('cheque.bad_status', 'Only a cheque in hand can be deposited');
    if (input.date < c.date) fail('cheque.date_before', 'Before the cheque was received');
    bankAccount(input.bankAccountId);
    db.tx(() => {
      db.update('cheques', id, { status: 'deposited', bank_account_id: input.bankAccountId, deposited_date: input.date, updated_at: nowIso() });
      audit().log({ userId, action: 'deposit', entity: 'cheque', entityId: id, summary: c.number });
    });
  }

  /** The bank paid (received) or debited (issued) the cheque. */
  function clear(id: number, input: { date: string; bankAccountId: number | null }, userId: number | null) {
    const c = cheque(id);
    if (!(c.status === 'deposited' || c.status === 'in_hand' || c.status === 'issued')) conflict('cheque.bad_status', 'This cheque is not open');
    if (input.date < c.date) fail('cheque.date_before', 'Before the cheque was received');
    const bank = bankAccount(input.bankAccountId ?? c.bank_account_id ?? fail('cheque.bank_account', 'Choose the bank account'));
    const received = c.direction === 'received';
    const holding = holdingAccount(c.direction);
    db.tx(() => {
      const entryId = ledger().createEntry(
        {
          date: input.date,
          reference: `${c.number} / ${c.cheque_no}`,
          memo: `Cheque ${c.cheque_no} cleared`,
          lines: [
            { accountId: bank.id, debit: received ? c.amount : 0, credit: received ? 0 : c.amount, description: `Cheque ${c.cheque_no}` },
            { accountId: holding, debit: received ? 0 : c.amount, credit: received ? c.amount : 0, description: `Cheque ${c.cheque_no}` },
          ],
        },
        { sourceType: 'cheque_clearing', sourceId: id, userId },
      );
      db.update('cheques', id, { status: 'cleared', bank_account_id: bank.id, cleared_date: input.date, clear_entry_id: entryId, deposited_date: c.deposited_date ?? input.date, updated_at: nowIso() });
      audit().log({ userId, action: 'clear', entity: 'cheque', entityId: id, summary: c.number });
    });
  }

  /** Undo a clearing booked by mistake (the bank statement did not show it). */
  function unclear(id: number, userId: number | null) {
    const c = cheque(id);
    if (c.status !== 'cleared') conflict('cheque.bad_status', 'This cheque is not cleared');
    db.tx(() => {
      ledger().reverseEntry(c.clear_entry_id!, { date: c.cleared_date, memo: `Undo clearing ${c.cheque_no}` }, userId);
      db.update('cheques', id, { status: c.direction === 'received' ? 'deposited' : 'issued', clear_entry_id: null, cleared_date: null, updated_at: nowIso() });
      audit().log({ userId, action: 'reverse', entity: 'cheque_clearing', entityId: id, summary: c.number });
    });
  }

  /**
   * The cheque will not be paid: bounced by the bank, handed back to the customer, or (issued)
   * cancelled. The party owes (or is owed) the money again and its invoices reopen.
   */
  function cancel(id: number, input: { date: string; outcome: 'bounced' | 'returned' | 'cancelled'; reason: string | null }, userId: number | null) {
    const c = cheque(id);
    if (!OPEN.includes(c.status)) conflict('cheque.bad_status', 'This cheque is not open');
    if (c.direction === 'received' && input.outcome === 'cancelled') fail('cheque.bad_outcome', 'A received cheque bounces or is returned');
    if (c.direction === 'issued' && input.outcome !== 'cancelled') fail('cheque.bad_outcome', 'An issued cheque is cancelled');
    if (input.date < c.date) fail('cheque.date_before', 'Before the cheque was received');
    const party = parties().get(c.party_id);
    const received = c.direction === 'received';
    const control = received ? parties().receivableAccount(party) : parties().payableAccount(party);
    const holding = holdingAccount(c.direction);
    db.tx(() => {
      docs().unsettleSource('cheque', id);
      const entryId = ledger().createEntry(
        {
          date: input.date,
          reference: `${c.number} / ${c.cheque_no}`,
          memo: `Cheque ${c.cheque_no} ${input.outcome}${input.reason ? ' — ' + input.reason : ''}`,
          lines: [
            { accountId: control, partyId: party.id, debit: received ? c.amount : 0, credit: received ? 0 : c.amount, description: party.name },
            { accountId: holding, debit: received ? 0 : c.amount, credit: received ? c.amount : 0, description: `Cheque ${c.cheque_no}` },
          ],
        },
        { sourceType: 'cheque_cancel', sourceId: id, userId },
      );
      db.update('cheques', id, { status: input.outcome, cancel_entry_id: entryId, cancelled_date: input.date, reason: input.reason, updated_at: nowIso() });
      audit().log({ userId, action: input.outcome, entity: 'cheque', entityId: id, summary: c.number });
    });
  }

  function view(id: number) {
    const c = cheque(id);
    const party = parties().get(c.party_id);
    const allocations = db.all(
      `SELECT a.document_id, a.amount, d.number, d.date, d.total FROM cheque_allocations a JOIN documents d ON d.id = a.document_id WHERE a.cheque_id = ?`,
      [id],
    );
    const bank = c.bank_account_id ? ledger().account(c.bank_account_id) : null;
    const je = (x: number | null) => (x ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [x])?.number ?? null : null);
    return { ...c, party_name: party.name, allocations, bank_code: bank?.code ?? null, bank_name_en: bank?.name_en ?? null, bank_name_ar: bank?.name_ar ?? null, entry_number: je(c.entry_id), clear_number: je(c.clear_entry_id), cancel_number: je(c.cancel_entry_id) };
  }

  /** Open cheques by when they fall due, from `asOf`. */
  function portfolio(asOf: string) {
    const open = db.all<Cheque & { party_name: string }>(
      `SELECT c.*, p.name AS party_name FROM cheques c JOIN parties p ON p.id = c.party_id WHERE c.status IN ('in_hand', 'deposited', 'issued') ORDER BY c.due_date, c.id`,
    );
    const bucket = (due: string) => (due < asOf ? 'overdue' : due <= addDays(asOf, 7) ? 'week' : due <= addDays(asOf, 30) ? 'month' : due <= addDays(asOf, 90) ? 'quarter' : 'later');
    const keys = ['overdue', 'week', 'month', 'quarter', 'later'] as const;
    const sum = (dir: Direction) => Object.fromEntries(keys.map((k) => [k, open.filter((c) => c.direction === dir && bucket(c.due_date) === k).reduce((s, c) => s + c.amount, 0)]));
    return {
      asOf,
      received: sum('received'),
      issued: sum('issued'),
      totals: {
        received: open.filter((c) => c.direction === 'received').reduce((s, c) => s + c.amount, 0),
        issued: open.filter((c) => c.direction === 'issued').reduce((s, c) => s + c.amount, 0),
        bounced: db.get<{ t: number }>(`SELECT COALESCE(SUM(amount), 0) t FROM cheques WHERE status = 'bounced' AND cancelled_date >= ?`, [addDays(asOf, -365)])!.t,
      },
      open: open.map((c) => ({ ...c, bucket: bucket(c.due_date) })),
    };
  }

  return { cheque, zCheque, create, deposit, clear, unclear, cancel, view, portfolio };
}

export const chequesModule: AppModule = {
  id: 'cheques',
  dependsOn: ['ledger', 'parties', 'documents'],
  permissions: ['cheques.received.read', 'cheques.received.write', 'cheques.issued.read', 'cheques.issued.write'],
  apps: [{ id: 'cheques', order: 35, permissions: ['cheques'] }],
  roles: [{ id: 'cheque_clerk', permissions: ['cheques.*', 'ar.customers.read', 'ap.suppliers.read', 'ar.invoices.read', 'ap.bills.read'] }],
  health({ db }) {
    // The holding accounts must be their own (not VAT, not a bank): cheques in hand are not tax.
    const shared = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM cheque_settings s JOIN taxes t
         ON t.sales_account_id IN (s.receivable_account_id, s.payable_account_id) OR t.purchase_account_id IN (s.receivable_account_id, s.payable_account_id)`,
    )!.n;
    const over = db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM cheques c WHERE (SELECT COALESCE(SUM(amount), 0) FROM cheque_allocations a WHERE a.cheque_id = c.id) > c.amount',
    )!.n;
    return [
      { id: 'allocated', ok: over === 0, details: { count: over } },
      { id: 'holding', ok: shared === 0 },
    ];
  },
  migrations: [
    {
      id: '001_cheques',
      up: `
        CREATE TABLE cheques (
          id              INTEGER PRIMARY KEY,
          direction       TEXT NOT NULL CHECK (direction IN ('received', 'issued')),
          number          TEXT NOT NULL UNIQUE,
          cheque_no       TEXT NOT NULL,
          bank_name       TEXT,
          party_id        INTEGER NOT NULL REFERENCES parties(id),
          amount          INTEGER NOT NULL CHECK (amount > 0),
          date            TEXT NOT NULL,                       -- received / written
          due_date        TEXT NOT NULL,                       -- the date on the cheque
          status          TEXT NOT NULL CHECK (status IN ('in_hand', 'deposited', 'cleared', 'bounced', 'returned', 'issued', 'cancelled')),
          bank_account_id INTEGER REFERENCES accounts(id),
          memo            TEXT,
          reason          TEXT,
          entry_id        INTEGER REFERENCES journal_entries(id),
          clear_entry_id  INTEGER REFERENCES journal_entries(id),
          cancel_entry_id INTEGER REFERENCES journal_entries(id),
          deposited_date  TEXT,
          cleared_date    TEXT,
          cancelled_date  TEXT,
          created_by      INTEGER REFERENCES users(id),
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX cheques_due ON cheques(status, due_date);
        CREATE INDEX cheques_party ON cheques(party_id);
        CREATE TABLE cheque_allocations (
          cheque_id   INTEGER NOT NULL REFERENCES cheques(id),
          document_id INTEGER NOT NULL REFERENCES documents(id),
          amount      INTEGER NOT NULL CHECK (amount > 0),
          PRIMARY KEY (cheque_id, document_id)
        );
        CREATE TABLE cheque_settings (
          id                    INTEGER PRIMARY KEY CHECK (id = 1),
          receivable_account_id INTEGER REFERENCES accounts(id),
          payable_account_id    INTEGER REFERENCES accounts(id)
        );
        INSERT INTO cheque_settings (id) VALUES (1);
        CREATE TRIGGER cheques_no_delete BEFORE DELETE ON cheques
        BEGIN SELECT RAISE(ABORT, 'cheques: cheques are cancelled, never deleted'); END;
      `,
    },
    {
      // Early versions could take the standard chart's 1150 (VAT input) as "Cheques receivable". Where no cheque
      // was booked yet, forget that choice so the right account is made on the next cheque; otherwise the health
      // check reports it.
      id: '002_holding_accounts',
      up: `
        UPDATE cheque_settings SET receivable_account_id = NULL
         WHERE receivable_account_id IN (SELECT sales_account_id FROM taxes UNION SELECT purchase_account_id FROM taxes)
           AND NOT EXISTS (SELECT 1 FROM cheques WHERE direction = 'received');
        UPDATE cheque_settings SET payable_account_id = NULL
         WHERE payable_account_id IN (SELECT sales_account_id FROM taxes UNION SELECT purchase_account_id FROM taxes)
           AND NOT EXISTS (SELECT 1 FROM cheques WHERE direction = 'issued');
      `,
    },
  ],

  setup(ctx) {
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('cheque_received', 'CHR-', 1, 5)");
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('cheque_issued', 'CHI-', 1, 5)");
  },

  routes(r, ctx) {
    const { db } = ctx;
    const ch = createCheques(ctx);
    const perm = (d: Direction, a: 'read' | 'write') => `cheques.${d}.${a}`;
    const need = (user: SessionUser, d: Direction, a: 'read' | 'write') => {
      if (!user.permissions.has(perm(d, a))) forbidden(perm(d, a));
    };

    r.get('/cheques', 'auth', ({ query, user }) => {
      const q = parse(z.object({ direction: z.enum(['received', 'issued']), status: z.string().optional() }), query);
      need(user, q.direction, 'read');
      return db.all(
        `SELECT c.*, p.name AS party_name FROM cheques c JOIN parties p ON p.id = c.party_id
         WHERE c.direction = ? ${q.status === 'open' ? `AND c.status IN ('in_hand', 'deposited', 'issued')` : ''}
         ORDER BY c.due_date DESC, c.id DESC`,
        [q.direction],
      );
    });
    r.get('/cheques/portfolio', 'auth', ({ query, user }) => {
      if (!user.permissions.has('cheques.received.read') && !user.permissions.has('cheques.issued.read')) need(user, 'received', 'read');
      return ch.portfolio(parse(z.object({ asOf: zDate.default(today()) }), query).asOf);
    });
    r.get('/cheques/open-documents', 'auth', ({ query, user }) => {
      const q = parse(z.object({ partyId: zId, direction: z.enum(['received', 'issued']) }), query);
      need(user, q.direction, 'read');
      return db.all(
        `SELECT id, number, date, due_date, total, amount_settled, total - amount_settled AS outstanding FROM documents
         WHERE party_id = ? AND kind = ? AND status = 'posted' AND amount_settled < total ORDER BY due_date, id`,
        [q.partyId, q.direction === 'received' ? 'sales_invoice' : 'purchase_bill'],
      );
    });
    r.get('/cheques/:id', 'auth', ({ params, user }) => {
      const v = ch.view(Number(params.id));
      need(user, v.direction, 'read');
      return v;
    });
    r.post('/cheques', 'auth', ({ body, user }) => {
      const input = parse(ch.zCheque, body);
      need(user, input.direction, 'write');
      return { id: ch.create(input, user.id) };
    });
    r.post('/cheques/:id/deposit', 'auth', ({ params, body, user }) => {
      need(user, ch.cheque(Number(params.id)).direction, 'write');
      ch.deposit(Number(params.id), parse(z.object({ date: zDate, bankAccountId: zId }), body), user.id);
      return { ok: true };
    });
    r.post('/cheques/:id/clear', 'auth', ({ params, body, user }) => {
      need(user, ch.cheque(Number(params.id)).direction, 'write');
      ch.clear(Number(params.id), parse(z.object({ date: zDate, bankAccountId: zOptId.transform((v) => v ?? null) }), body), user.id);
      return { ok: true };
    });
    r.post('/cheques/:id/unclear', 'auth', ({ params, user }) => {
      need(user, ch.cheque(Number(params.id)).direction, 'write');
      ch.unclear(Number(params.id), user.id);
      return { ok: true };
    });
    r.post('/cheques/:id/cancel', 'auth', ({ params, body, user }) => {
      need(user, ch.cheque(Number(params.id)).direction, 'write');
      ch.cancel(Number(params.id), parse(z.object({ date: zDate, outcome: z.enum(['bounced', 'returned', 'cancelled']), reason: zOptText(300) }), body), user.id);
      return { ok: true };
    });
  },
};
