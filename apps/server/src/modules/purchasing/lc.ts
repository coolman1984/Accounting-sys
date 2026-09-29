import { z } from 'zod';
import type { ModuleContext, Router } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import { parse, zBp, zDate, zId, zOptId, zOptText, zPositiveMinor } from '../../kernel/validate.js';
import { ON_DEMAND, type TemplateAccount } from '../ledger/chart-template.js';
import type { Account, JournalLineInput } from '../ledger/service.js';
import { RATE_SCALE } from '../../contracts/fx.js';
import type {} from '../../contracts/documents.js';

export interface LetterOfCredit {
  id: number;
  number: string;
  lc_number: string;
  supplier_id: number;
  po_id: number | null;
  bank_account_id: number;
  currency: string;
  amount: number;
  margin_bp: number;
  margin_amount: number;
  margin_base: number;
  margin_used_base: number;
  opening_rate: number;
  margin_account_id: number;
  financing_account_id: number;
  charges_account_id: number;
  opening_date: string;
  expiry_date: string;
  latest_shipment_date: string | null;
  status: 'opened' | 'documents_received' | 'settled' | 'cancelled';
  settled_amount: number;
  financed_base: number;
  repaid_base: number;
  margin_entry_id: number | null;
  documents_date: string | null;
  notes: string | null;
}

/** Accounts an LC needs, created on first use when the chart has none (the standard chart has Bank Charges 5800). */
const ACCOUNTS: Record<'margin' | 'financing' | 'charges', TemplateAccount & { parentCode: string }> = {
  margin: { code: '1175', en: 'LC Cash Margin', ar: 'غطاء نقدي لخطابات الاعتماد', type: 'asset', subtype: 'current_asset', parentCode: '11' },
  financing: { code: '2175', en: 'LC Bank Financing', ar: 'تمويل بنكي لخطابات الاعتماد', type: 'liability', subtype: 'short_term_debt', parentCode: '21' },
  charges: { code: '5800', en: 'Bank Charges', ar: 'مصروفات بنكية', type: 'expense', subtype: 'other_expense', parentCode: '5' },
};

const zLc = z.object({
  lcNumber: z.string().trim().min(1).max(60),
  supplierId: zId,
  poId: zOptId.transform((v) => v ?? null),
  bankAccountId: zId,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  amount: zPositiveMinor,
  marginBp: zBp.default(0),
  exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null),
  openingDate: zDate,
  expiryDate: zDate,
  latestShipmentDate: zDate.nullish().transform((v) => v ?? null),
  marginAccountId: zOptId.transform((v) => v ?? null),
  financingAccountId: zOptId.transform((v) => v ?? null),
  chargesAccountId: zOptId.transform((v) => v ?? null),
  /** Opening commission, in the base currency, posted with the margin. */
  openingCharges: z.number().int().min(0).default(0),
  notes: zOptText(2000),
});
const zCharges = z.object({ date: zDate, amount: zPositiveMinor, memo: zOptText(300) });
const zSettle = z.object({ documentId: zId, amount: zPositiveMinor.nullish().transform((v) => v ?? null), date: zDate, exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null) });
const zRepay = z.object({ date: zDate, amount: zPositiveMinor, bankAccountId: zOptId.transform((v) => v ?? null) });
const zDated = z.object({ date: zDate.nullish().transform((v) => v ?? null) });

const mulDiv = (a: number, b: number, c: number) => Number(divRound(BigInt(a) * BigInt(b), BigInt(c)));

/**
 * Letters of credit (optional per purchase order — a documentary collection or open account needs none).
 *
 *   open        Dr LC cash margin            / Cr bank                (margin % of the LC, at the opening rate)
 *               Dr bank charges              / Cr bank                (opening commission, optional)
 *   charges     Dr bank charges              / Cr bank
 *   settle      Dr payable (supplier, the bill's historical base value)
 *               Cr LC cash margin (its share) / Cr LC bank financing (the rest, at the settlement rate)
 *               ± realised exchange difference; the bill is settled from the LC
 *   repay       Dr LC bank financing         / Cr bank
 *   settled / cancelled: the unused margin goes back to the bank.
 * Every entry goes through the ledger service; nothing is written to the ledger's tables directly.
 */
export function createLettersOfCredit(ctx: ModuleContext) {
  const { db, services, apps } = ctx;
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');

  const get = (id: number) => db.get<LetterOfCredit>('SELECT * FROM letters_of_credit WHERE id = ?', [id]) ?? notFound('letter_of_credit', id);
  const base = () => services.get('settings').company()?.baseCurrency ?? '';
  const foreign = (code: string) => code !== base();
  const fx = () => {
    if (!services.has('fx') || !apps.isEnabled('fx')) return fail('fx.unavailable', 'Multi-currency is not in use');
    return services.get('fx');
  };
  const rateOn = (code: string, date: string, given: number | null) => (foreign(code) ? given ?? fx().rate(code, date) : RATE_SCALE);
  const toBase = (amount: number, rate: number) => (rate === RATE_SCALE ? amount : fx().toBase(amount, rate));

  const postable = (id: number, label: string): Account => {
    const a = ledger().account(id);
    if (a.is_group || !a.is_active) fail('lc.account', `${label}: choose an active posting account`, { code: a.code });
    return a;
  };

  /** A line on a bank account (kept in the base currency, or in a foreign one with its amount in that currency). */
  function bankLine(acc: Account, side: 'debit' | 'credit', baseAmount: number, known: { currency: string; amount: number } | null, date: string, description: string): JournalLineInput {
    const l: JournalLineInput = { accountId: acc.id, debit: side === 'debit' ? baseAmount : 0, credit: side === 'credit' ? baseAmount : 0, description };
    if (acc.currency) {
      const fxAmount = known && known.currency === acc.currency ? known.amount : mulDiv(baseAmount, RATE_SCALE, fx().rate(acc.currency, date));
      l.currency = acc.currency;
      l.amountFx = side === 'debit' ? fxAmount : -fxAmount;
    }
    return l;
  }

  function entry(lc: Pick<LetterOfCredit, 'id' | 'number' | 'lc_number'>, date: string, memo: string, lines: JournalLineInput[], userId: number | null): number {
    return ledger().createEntry({ date, memo: `${lc.number} (${lc.lc_number}) — ${memo}`, reference: lc.lc_number, lines: lines.filter((l) => l.debit > 0 || l.credit > 0) }, { sourceType: 'letter_of_credit', sourceId: lc.id, userId });
  }

  function event(lcId: number, e: { kind: string; date: string; amount?: number; baseAmount?: number; rate?: number | null; documentId?: number | null; entryId?: number | null; memo?: string | null }, userId: number | null): number {
    return db.insert('lc_events', {
      lc_id: lcId, kind: e.kind, date: e.date, amount: e.amount ?? 0, base_amount: e.baseAmount ?? 0, rate: e.rate ?? null,
      document_id: e.documentId ?? null, entry_id: e.entryId ?? null, memo: e.memo ?? null, created_by: userId, created_at: nowIso(),
    });
  }

  function open(input: z.infer<typeof zLc>, userId: number | null): number {
    const party = services.get('parties').get(input.supplierId);
    services.get('parties').assertKind(party, 'supplier');
    let currency = input.currency ?? base();
    if (input.poId) {
      const po = db.get<{ supplier_id: number; currency: string | null; status: string; number: string | null }>('SELECT supplier_id, currency, status, number FROM purchase_orders WHERE id = ?', [input.poId]) ?? notFound('purchase_order', input.poId);
      if (po.supplier_id !== input.supplierId) fail('lc.po_supplier', `Order ${po.number} belongs to another supplier`);
      if (po.status !== 'open') fail('lc.po_not_open', `Order ${po.number ?? ''} is not approved and open`);
      const poCur = po.currency ?? base();
      if (input.currency && input.currency !== poCur) fail('lc.po_currency', `Order ${po.number} is in ${poCur}`, { currency: poCur });
      currency = poCur;
    }
    if (foreign(currency)) fx().assertCurrency(currency);
    if (input.expiryDate < input.openingDate) fail('lc.dates', 'The expiry date is before the opening date');
    if (input.latestShipmentDate && (input.latestShipmentDate < input.openingDate || input.latestShipmentDate > input.expiryDate)) fail('lc.shipment_date', 'The latest shipment date must fall between opening and expiry');
    const bank = postable(input.bankAccountId, 'Bank');
    if (bank.subtype !== 'bank') fail('lc.bank_account', 'Choose a bank account');
    if (bank.currency && bank.currency !== currency) fail('lc.bank_currency', `The bank account is kept in ${bank.currency}`, { currency: bank.currency });
    const rate = rateOn(currency, input.openingDate, input.exchangeRate);
    const marginAmount = mulDiv(input.amount, input.marginBp, 10000);
    const marginBase = toBase(marginAmount, rate);
    ledger().assertPostingDate(input.openingDate);
    return db.tx(() => {
      const acc = (given: number | null, key: keyof typeof ACCOUNTS, label: string) => postable(given ?? ledger().ensureAccount(ACCOUNTS[key]), label).id;
      const marginAcc = acc(input.marginAccountId, 'margin', 'Cash margin');
      const financingAcc = acc(input.financingAccountId, 'financing', 'Bank financing');
      const chargesAcc = acc(input.chargesAccountId, 'charges', 'Bank charges');
      const number = services.get('sequences').next('letter_of_credit');
      const id = db.insert('letters_of_credit', {
        number, lc_number: input.lcNumber, supplier_id: input.supplierId, po_id: input.poId, bank_account_id: bank.id, currency, amount: input.amount,
        margin_bp: input.marginBp, margin_amount: marginAmount, margin_base: marginBase, margin_used_base: 0, opening_rate: rate,
        margin_account_id: marginAcc, financing_account_id: financingAcc, charges_account_id: chargesAcc,
        opening_date: input.openingDate, expiry_date: input.expiryDate, latest_shipment_date: input.latestShipmentDate, status: 'opened',
        notes: input.notes, created_by: userId, created_at: nowIso(), updated_at: nowIso(),
      });
      const lc = { id, number, lc_number: input.lcNumber };
      if (marginBase > 0 || input.openingCharges > 0) {
        const lines: JournalLineInput[] = [];
        if (marginBase > 0) {
          lines.push({ accountId: marginAcc, debit: marginBase, credit: 0, description: `Cash margin ${input.marginBp / 100}%` });
          lines.push(bankLine(bank, 'credit', marginBase, { currency, amount: marginAmount }, input.openingDate, 'Cash margin'));
        }
        if (input.openingCharges > 0) {
          lines.push({ accountId: chargesAcc, debit: input.openingCharges, credit: 0, description: 'Opening commission' });
          lines.push(bankLine(bank, 'credit', input.openingCharges, null, input.openingDate, 'Opening commission'));
        }
        const je = entry(lc, input.openingDate, 'opening', lines, userId);
        db.run('UPDATE letters_of_credit SET margin_entry_id = ? WHERE id = ?', [je, id]);
        if (marginBase > 0) event(id, { kind: 'margin', date: input.openingDate, amount: marginAmount, baseAmount: marginBase, rate, entryId: je }, userId);
        if (input.openingCharges > 0) event(id, { kind: 'charges', date: input.openingDate, baseAmount: input.openingCharges, entryId: je, memo: 'Opening commission' }, userId);
      }
      audit().log({ userId, action: 'create', entity: 'letter_of_credit', entityId: id, summary: `${number} ${input.lcNumber}` });
      return id;
    });
  }

  const assertActive = (lc: LetterOfCredit) => {
    if (lc.status !== 'opened' && lc.status !== 'documents_received') conflict('lc.closed', `${lc.number} is ${lc.status}`, { status: lc.status });
  };

  function charges(id: number, input: z.infer<typeof zCharges>, userId: number | null) {
    const lc = get(id);
    if (lc.status === 'cancelled') conflict('lc.closed', `${lc.number} is cancelled`);
    const bank = ledger().account(lc.bank_account_id);
    db.tx(() => {
      const je = entry(lc, input.date, input.memo ?? 'bank charges', [
        { accountId: lc.charges_account_id, debit: input.amount, credit: 0, description: input.memo ?? 'Bank charges' },
        bankLine(bank, 'credit', input.amount, null, input.date, input.memo ?? 'Bank charges'),
      ], userId);
      event(id, { kind: 'charges', date: input.date, baseAmount: input.amount, entryId: je, memo: input.memo }, userId);
      audit().log({ userId, action: 'charges', entity: 'letter_of_credit', entityId: id, summary: lc.number });
    });
  }

  function documentsReceived(id: number, date: string | null, userId: number | null) {
    const lc = get(id);
    if (lc.status !== 'opened') conflict('lc.status', `${lc.number} is ${lc.status}`, { status: lc.status });
    db.tx(() => {
      db.run("UPDATE letters_of_credit SET status = 'documents_received', documents_date = ?, updated_at = ? WHERE id = ?", [date ?? today(), nowIso(), id]);
      event(id, { kind: 'documents', date: date ?? today() }, userId);
      audit().log({ userId, action: 'documents', entity: 'letter_of_credit', entityId: id, summary: lc.number });
    });
  }

  /** Give the unused margin back to the bank account (settled or cancelled LC). */
  function releaseMargin(lc: LetterOfCredit, date: string, kind: 'release' | 'cancel', userId: number | null) {
    const left = lc.margin_base - lc.margin_used_base;
    if (left <= 0) return event(lc.id, { kind, date }, userId);
    const bank = ledger().account(lc.bank_account_id);
    const leftFx = lc.margin_used_base === 0 ? lc.margin_amount : mulDiv(lc.margin_amount, left, lc.margin_base);
    const je = entry(lc, date, kind === 'cancel' ? 'cancelled, margin released' : 'margin released', [
      bankLine(bank, 'debit', left, { currency: lc.currency, amount: leftFx }, date, 'Cash margin released'),
      { accountId: lc.margin_account_id, debit: 0, credit: left, description: 'Cash margin released' },
    ], userId);
    db.run('UPDATE letters_of_credit SET margin_used_base = margin_base WHERE id = ?', [lc.id]);
    return event(lc.id, { kind, date, amount: leftFx, baseAmount: left, entryId: je }, userId);
  }

  /** The bank pays the supplier's bill from the LC: margin first, the rest financed by the bank. */
  function settle(id: number, input: z.infer<typeof zSettle>, userId: number | null) {
    const lc = get(id);
    assertActive(lc);
    const docs = services.get('documents');
    const doc = docs.get(input.documentId);
    if (doc.kind !== 'purchase_bill' || doc.status !== 'posted') fail('lc.not_bill', 'Choose a posted supplier invoice');
    if (doc.party_id !== lc.supplier_id) fail('lc.bill_supplier', 'That invoice belongs to another supplier');
    if (doc.currency !== lc.currency) fail('lc.bill_currency', `The invoice is in ${doc.currency}, the letter of credit in ${lc.currency}`, { currency: doc.currency });
    const outstanding = doc.total - doc.amount_settled;
    const remaining = lc.amount - lc.settled_amount;
    const amount = input.amount ?? Math.min(outstanding, remaining);
    if (amount <= 0 || amount > outstanding) fail('lc.over_bill', `Only ${outstanding} is outstanding on ${doc.number}`, { outstanding });
    if (amount > remaining) fail('lc.over_amount', `Only ${remaining} is left on ${lc.number}`, { remaining });
    const rate = rateOn(lc.currency, input.date, input.exchangeRate);
    const settleBase = toBase(amount, rate);
    const apBase = docs.baseFor(doc, amount);
    const last = amount === remaining;
    const marginLeft = lc.margin_base - lc.margin_used_base;
    const marginUsed = Math.min(last ? marginLeft : Math.min(marginLeft, mulDiv(lc.margin_base, amount, lc.amount)), settleBase);
    const financing = settleBase - marginUsed;
    const diff = settleBase - apBase;
    const supplier = services.get('parties').get(lc.supplier_id);
    ledger().assertPostingDate(input.date);
    db.tx(() => {
      const lines: JournalLineInput[] = [
        {
          accountId: services.get('parties').payableAccount(supplier), partyId: supplier.id, debit: apBase, credit: 0, description: `${doc.number} paid by ${lc.lc_number}`,
          ...(foreign(lc.currency) ? { currency: lc.currency, amountFx: amount } : {}),
        },
        { accountId: lc.margin_account_id, debit: 0, credit: marginUsed, description: 'Cash margin applied' },
        { accountId: lc.financing_account_id, debit: 0, credit: financing, description: 'Financed by the bank' },
      ];
      if (diff > 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxLoss', ON_DEMAND.fxLoss), debit: diff, credit: 0, description: 'Realised exchange difference' });
      if (diff < 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxGain', ON_DEMAND.fxGain), debit: 0, credit: -diff, description: 'Realised exchange difference' });
      const je = entry(lc, input.date, `settles ${doc.number}`, lines, userId);
      const ev = event(id, { kind: 'settlement', date: input.date, amount, baseAmount: settleBase, rate, documentId: doc.id, entryId: je }, userId);
      docs.settle(doc.id, { sourceType: 'lc', sourceId: ev, sourceNumber: lc.number, amount, date: input.date, baseAmount: apBase, sourceBaseAmount: settleBase });
      db.run(
        'UPDATE letters_of_credit SET settled_amount = settled_amount + ?, margin_used_base = margin_used_base + ?, financed_base = financed_base + ?, updated_at = ? WHERE id = ?',
        [amount, marginUsed, financing, nowIso(), id],
      );
      if (last) {
        db.run("UPDATE letters_of_credit SET status = 'settled' WHERE id = ?", [id]);
        releaseMargin(get(id), input.date, 'release', userId);
      }
      audit().log({ userId, action: 'settle', entity: 'letter_of_credit', entityId: id, summary: `${lc.number} → ${doc.number}` });
    });
  }

  /** Pay the bank back what it financed. */
  function repay(id: number, input: z.infer<typeof zRepay>, userId: number | null) {
    const lc = get(id);
    const left = lc.financed_base - lc.repaid_base;
    if (input.amount > left) fail('lc.over_repay', `Only ${left} is financed and not repaid`, { left });
    const bank = postable(input.bankAccountId ?? lc.bank_account_id, 'Bank');
    if (bank.subtype !== 'bank' && bank.subtype !== 'cash') fail('lc.bank_account', 'Choose a bank or cash account');
    db.tx(() => {
      const je = entry(lc, input.date, 'financing repaid', [
        { accountId: lc.financing_account_id, debit: input.amount, credit: 0, description: 'Financing repaid' },
        bankLine(bank, 'credit', input.amount, null, input.date, 'Financing repaid'),
      ], userId);
      event(id, { kind: 'repayment', date: input.date, baseAmount: input.amount, entryId: je }, userId);
      db.run('UPDATE letters_of_credit SET repaid_base = repaid_base + ?, updated_at = ? WHERE id = ?', [input.amount, nowIso(), id]);
      audit().log({ userId, action: 'repay', entity: 'letter_of_credit', entityId: id, summary: lc.number });
    });
  }

  /** Close an LC that will not be used further (partly used, or not at all). */
  function close(id: number, date: string | null, userId: number | null) {
    const lc = get(id);
    assertActive(lc);
    const d = date ?? today();
    db.tx(() => {
      const cancel = lc.settled_amount === 0;
      db.run('UPDATE letters_of_credit SET status = ?, updated_at = ? WHERE id = ?', [cancel ? 'cancelled' : 'settled', nowIso(), id]);
      releaseMargin(lc, d, cancel ? 'cancel' : 'release', userId);
      audit().log({ userId, action: cancel ? 'cancel' : 'close', entity: 'letter_of_credit', entityId: id, summary: lc.number });
    });
  }

  return { get, open, charges, documentsReceived, settle, repay, close };
}

export type LcService = ReturnType<typeof createLettersOfCredit>;

export function lcRoutes(r: Router, { db, services }: ModuleContext, lcs: LcService) {
  r.get('/letters-of-credit', 'purchasing.lc.read', () =>
    db.all(
      `SELECT c.*, p.name AS supplier_name, o.number AS po_number, a.code AS bank_code, a.name_en AS bank_name_en, a.name_ar AS bank_name_ar
       FROM letters_of_credit c JOIN parties p ON p.id = c.supplier_id JOIN accounts a ON a.id = c.bank_account_id
       LEFT JOIN purchase_orders o ON o.id = c.po_id ORDER BY c.opening_date DESC, c.id DESC`,
    ),
  );
  r.get('/letters-of-credit/:id', 'purchasing.lc.read', ({ params }) => {
    const lc = lcs.get(parse(zId, params.id));
    const acct = (id: number) => db.get('SELECT id, code, name_en, name_ar, currency FROM accounts WHERE id = ?', [id]);
    return {
      ...lc,
      supplier: services.get('parties').get(lc.supplier_id),
      po: lc.po_id ? db.get('SELECT id, number, status, currency, total FROM purchase_orders WHERE id = ?', [lc.po_id]) : null,
      bank_account: acct(lc.bank_account_id),
      margin_account: acct(lc.margin_account_id),
      financing_account: acct(lc.financing_account_id),
      charges_account: acct(lc.charges_account_id),
      events: db.all(
        `SELECT e.*, d.number AS document_number, j.number AS entry_number FROM lc_events e
         LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN journal_entries j ON j.id = e.entry_id WHERE e.lc_id = ? ORDER BY e.id`,
        [lc.id],
      ),
      // Posted supplier invoices this LC can pay.
      open_bills: db.all(
        `SELECT id, number, date, currency, total, amount_settled, total - amount_settled AS outstanding FROM documents
         WHERE kind = 'purchase_bill' AND status = 'posted' AND party_id = ? AND currency = ? AND amount_settled < total ORDER BY date, id`,
        [lc.supplier_id, lc.currency],
      ),
    };
  });
  r.post('/letters-of-credit', 'purchasing.lc.write', ({ body, user }) => ({ id: lcs.open(parse(zLc, body), user.id) }));
  r.post('/letters-of-credit/:id/charges', 'purchasing.lc.write', ({ params, body, user }) => (lcs.charges(parse(zId, params.id), parse(zCharges, body), user.id), { ok: true }));
  r.post('/letters-of-credit/:id/documents', 'purchasing.lc.write', ({ params, body, user }) => (lcs.documentsReceived(parse(zId, params.id), parse(zDated, body ?? {}).date, user.id), { ok: true }));
  r.post('/letters-of-credit/:id/settle', 'purchasing.lc.write', ({ params, body, user }) => (lcs.settle(parse(zId, params.id), parse(zSettle, body), user.id), { ok: true }));
  r.post('/letters-of-credit/:id/repay', 'purchasing.lc.write', ({ params, body, user }) => (lcs.repay(parse(zId, params.id), parse(zRepay, body), user.id), { ok: true }));
  r.post('/letters-of-credit/:id/close', 'purchasing.lc.write', ({ params, body, user }) => (lcs.close(parse(zId, params.id), parse(zDated, body ?? {}).date, user.id), { ok: true }));
}
