import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { ON_DEMAND } from '../ledger/chart-template.js';
import type { JournalLineInput } from '../ledger/service.js';
import type {} from '../../contracts/fx.js';

export interface Transfer {
  id: number;
  number: string | null;
  date: string;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  /** Received, in the receiving account's currency (only when the two accounts differ in currency). */
  to_amount: number | null;
  fee: number;
  fee_account_id: number | null;
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
  entry_id: number | null;
}

export interface TransferInput {
  date: string;
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  toAmount?: number | null;
  fee: number;
  feeAccountId: number | null;
  reference: string | null;
  memo: string | null;
}

export interface Statement {
  id: number;
  account_id: number;
  date: string;
  reference: string | null;
  opening_balance: number;
  closing_balance: number;
  status: 'open' | 'reconciled';
  reconciled_at: string | null;
}

export interface StatementLineInput {
  date: string;
  description: string;
  reference: string | null;
  amount: number;
}

interface StatementLine {
  id: number;
  statement_id: number;
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  journal_line_id: number | null;
}

/** A posted ledger line on a bank account, signed like a statement (+ in, − out). */
export interface BookLine {
  id: number;
  entry_id: number;
  number: string | null;
  date: string;
  reference: string | null;
  memo: string | null;
  description: string | null;
  source_type: string;
  amount: number;
}

export const SEQ_TRANSFER = 'transfer';

/**
 * SQL: the amount of ledger line `l` as the bank shows it — in the account's own currency for a
 * foreign-currency account (needs `accounts a` joined on l.account_id).
 */
export const BANK_AMOUNT = (l: string, a: string) => `(CASE WHEN ${a}.currency IS NOT NULL THEN COALESCE(${l}.amount_fx, 0) ELSE ${l}.debit - ${l}.credit END)`;

/**
 * SQL condition: ledger line `l` still waits for the bank. An entry that was reversed
 * (a voided payment or transfer) cancels out with its reversal — the bank never saw
 * either, so the pair is left out unless one of them was already ticked off.
 */
export const UNCLEARED = (l: string) => `
  NOT EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s.journal_line_id = ${l}.id)
  AND NOT EXISTS (
    SELECT 1 FROM journal_entries e
    WHERE e.id = ${l}.entry_id AND COALESCE(e.reversed_by_id, e.reversal_of_id) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bank_statement_lines s JOIN journal_lines jl ON jl.id = s.journal_line_id
        WHERE jl.entry_id IN (e.id, COALESCE(e.reversed_by_id, e.reversal_of_id))))`;
/** How far apart (days) a statement line and a ledger line may be dated and still match automatically. */
const MATCH_WINDOW_DAYS = 10;

export function createBanking({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');

  function cashAccount(id: number, label: string) {
    const a = ledger().account(id);
    if (a.subtype !== 'cash' && a.subtype !== 'bank') fail('bank.not_cash_account', `${label}: choose a cash or bank account`, { code: a.code });
    if (a.is_group) fail('account.group_not_allowed', `${label}: choose a posting account, not a group`);
    if (!a.is_active) fail('journal.inactive_account', `${a.code} is inactive`, { code: a.code, line: 0 });
    return a;
  }

  // ------------------------------------------------------------------ transfers

  function transfer(id: number): Transfer {
    return db.get<Transfer>('SELECT * FROM bank_transfers WHERE id = ?', [id]) ?? notFound('bank_transfer', id);
  }

  function checkTransfer(t: TransferInput) {
    if (t.fromAccountId === t.toAccountId) fail('bank.same_account', 'Choose two different accounts');
    const from = cashAccount(t.fromAccountId, 'From');
    const to = cashAccount(t.toAccountId, 'To');
    if ((from.currency || to.currency) && !services.has('fx')) fail('fx.unavailable', 'Multi-currency is not installed');
    if (from.currency !== to.currency && !t.toAmount) fail('bank.to_amount_required', 'Enter the amount received in the other currency');
    if (t.fee > 0) {
      if (!t.feeAccountId) return fail('bank.fee_account', 'Choose the account for the bank charges');
      const f = ledger().account(t.feeAccountId);
      if (f.is_group || f.type !== 'expense') fail('bank.fee_account', 'Bank charges go to an expense account');
    }
  }

  const row = (t: TransferInput) => ({
    date: t.date,
    from_account_id: t.fromAccountId,
    to_account_id: t.toAccountId,
    amount: t.amount,
    to_amount: t.toAmount ?? null,
    fee: t.fee,
    fee_account_id: t.fee > 0 ? t.feeAccountId : null,
    reference: t.reference,
    memo: t.memo,
  });

  function createTransfer(t: TransferInput, userId: number | null): number {
    checkTransfer(t);
    return db.tx(() => {
      const id = db.insert('bank_transfers', { ...row(t), status: 'draft', created_by: userId, created_at: nowIso() });
      audit().log({ userId, action: 'create', entity: 'bank_transfer', entityId: id, summary: 'draft' });
      return id;
    });
  }

  function updateTransfer(id: number, t: TransferInput, userId: number | null) {
    if (transfer(id).status !== 'draft') conflict('bank.not_draft', 'Only drafts can be changed');
    checkTransfer(t);
    db.tx(() => {
      db.update('bank_transfers', id, row(t));
      audit().log({ userId, action: 'update', entity: 'bank_transfer', entityId: id });
    });
  }

  /** Post: the receiving account gets the amount, the sending one pays amount + charges. */
  function postTransfer(id: number, userId: number | null) {
    const t = transfer(id);
    if (t.status !== 'draft') conflict('bank.not_draft', 'This transfer is already posted');
    checkTransfer({ date: t.date, fromAccountId: t.from_account_id, toAccountId: t.to_account_id, amount: t.amount, toAmount: t.to_amount, fee: t.fee, feeAccountId: t.fee_account_id, reference: t.reference, memo: t.memo });
    ledger().assertPostingDate(t.date);
    const from = ledger().account(t.from_account_id);
    const to = ledger().account(t.to_account_id);
    // Each side in base currency at the day's rate; selling or buying currency leaves an exchange difference.
    const base = (cur: string | null, amt: number) => (cur ? services.get('fx').toBase(amt, services.get('fx').rate(cur, t.date)) : amt);
    const received = from.currency === to.currency ? t.amount : t.to_amount!;
    const outBase = base(from.currency, t.amount + t.fee);
    const inBase = base(to.currency, received);
    const feeBase = base(from.currency, t.fee);
    const lines: JournalLineInput[] = [
      { accountId: t.to_account_id, debit: inBase, credit: 0, description: t.memo, ...(to.currency ? { currency: to.currency, amountFx: received } : {}) },
      { accountId: t.from_account_id, debit: 0, credit: outBase, description: t.memo, ...(from.currency ? { currency: from.currency, amountFx: -(t.amount + t.fee) } : {}) },
    ];
    if (t.fee > 0) lines.push({ accountId: t.fee_account_id!, debit: feeBase, credit: 0, description: t.memo });
    const diff = outBase - inBase - (t.fee > 0 ? feeBase : 0);
    if (diff > 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxLoss', ON_DEMAND.fxLoss), debit: diff, credit: 0, description: 'Exchange difference' });
    if (diff < 0) lines.push({ accountId: ledger().ensureDefaultAccount('fxGain', ON_DEMAND.fxGain), debit: 0, credit: -diff, description: 'Exchange difference' });
    db.tx(() => {
      const number = services.get('sequences').next(SEQ_TRANSFER);
      const entryId = ledger().createEntry(
        { date: t.date, reference: number, memo: t.memo ?? `Transfer ${number}`, lines },
        { sourceType: 'transfer', sourceId: id, userId, post: true },
      );
      db.run(`UPDATE bank_transfers SET status = 'posted', number = ?, entry_id = ?, posted_at = ? WHERE id = ?`, [number, entryId, nowIso(), id]);
      audit().log({ userId, action: 'post', entity: 'bank_transfer', entityId: id, summary: number });
    });
  }

  function voidTransfer(id: number, date: string | null, userId: number | null) {
    const t = transfer(id);
    if (t.status !== 'posted') conflict('bank.not_posted', 'Only posted transfers can be voided');
    db.tx(() => {
      ledger().reverseEntry(t.entry_id!, { date: date ?? t.date, memo: `Void ${t.number}`, sourceType: 'transfer_void' }, userId);
      db.run(`UPDATE bank_transfers SET status = 'void' WHERE id = ?`, [id]);
      audit().log({ userId, action: 'void', entity: 'bank_transfer', entityId: id, summary: t.number });
    });
  }

  function deleteTransfer(id: number, userId: number | null) {
    if (transfer(id).status !== 'draft') conflict('bank.not_draft', 'Posted transfers are voided, not deleted');
    db.tx(() => {
      db.run('DELETE FROM bank_transfers WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'bank_transfer', entityId: id });
    });
  }

  // ------------------------------------------------------------ reconciliation

  function statement(id: number): Statement {
    return db.get<Statement>('SELECT * FROM bank_statements WHERE id = ?', [id]) ?? notFound('bank_statement', id);
  }
  function line(id: number): StatementLine {
    return db.get<StatementLine>('SELECT * FROM bank_statement_lines WHERE id = ?', [id]) ?? notFound('bank_statement_line', id);
  }
  const assertOpen = (s: Statement) => {
    if (s.status !== 'open') conflict('bank.reconciled', 'This statement is reconciled — reopen it first');
  };

  /** Closing balance of the latest reconciled statement — where the next one must start. */
  function lastReconciled(accountId: number): Statement | null {
    return db.get<Statement>(`SELECT * FROM bank_statements WHERE account_id = ? AND status = 'reconciled' ORDER BY date DESC, id DESC LIMIT 1`, [accountId]) ?? null;
  }

  /** Posted ledger lines of the account that no statement has ticked off yet. */
  function uncleared(accountId: number, upTo?: string): BookLine[] {
    return db.all<BookLine>(
      `SELECT l.id, l.entry_id, l.number, l.date, l.reference, l.memo, l.description, l.source_type, ${BANK_AMOUNT('l', 'a')} AS amount
       FROM ledger l JOIN accounts a ON a.id = l.account_id
       WHERE l.account_id = ? ${upTo ? 'AND l.date <= ?' : ''} AND ${UNCLEARED('l')}
         AND NOT (a.currency IS NOT NULL AND COALESCE(l.amount_fx, 0) = 0)
       ORDER BY l.date, l.id`,
      upTo ? [accountId, upTo] : [accountId],
    );
  }

  function insertLines(statementId: number, lines: StatementLineInput[]) {
    let n = db.get<{ n: number }>('SELECT COALESCE(MAX(line_no), 0) n FROM bank_statement_lines WHERE statement_id = ?', [statementId])!.n;
    for (const l of lines) {
      db.insert('bank_statement_lines', { statement_id: statementId, line_no: ++n, date: l.date, description: l.description, reference: l.reference, amount: l.amount });
    }
  }

  function createStatement(
    s: { accountId: number; date: string; reference: string | null; openingBalance: number | null; closingBalance: number; lines: StatementLineInput[] },
    userId: number | null,
  ): number {
    cashAccount(s.accountId, 'Account');
    if (db.get(`SELECT 1 FROM bank_statements WHERE account_id = ? AND status = 'open'`, [s.accountId])) {
      conflict('bank.open_exists', 'Finish the open statement of this account first');
    }
    const prev = lastReconciled(s.accountId);
    if (prev && s.date <= prev.date) fail('bank.date_before', `The statement must be dated after ${prev.date}`, { date: prev.date });
    const opening = s.openingBalance ?? prev?.closing_balance ?? 0;
    if (prev && opening !== prev.closing_balance) {
      fail('bank.opening_mismatch', 'The opening balance must equal the last reconciled closing balance', { expected: prev.closing_balance });
    }
    return db.tx(() => {
      const id = db.insert('bank_statements', {
        account_id: s.accountId,
        date: s.date,
        reference: s.reference,
        opening_balance: opening,
        closing_balance: s.closingBalance,
        status: 'open',
        created_by: userId,
        created_at: nowIso(),
      });
      insertLines(id, s.lines);
      audit().log({ userId, action: 'create', entity: 'bank_statement', entityId: id, summary: s.date });
      return id;
    });
  }

  function updateStatement(id: number, s: { date: string; reference: string | null; closingBalance: number }, userId: number | null) {
    const cur = statement(id);
    assertOpen(cur);
    const prev = lastReconciled(cur.account_id);
    if (prev && s.date <= prev.date) fail('bank.date_before', `The statement must be dated after ${prev.date}`, { date: prev.date });
    db.tx(() => {
      db.update('bank_statements', id, { date: s.date, reference: s.reference, closing_balance: s.closingBalance });
      audit().log({ userId, action: 'update', entity: 'bank_statement', entityId: id });
    });
  }

  function addLines(id: number, lines: StatementLineInput[], userId: number | null) {
    assertOpen(statement(id));
    db.tx(() => {
      insertLines(id, lines);
      audit().log({ userId, action: 'update', entity: 'bank_statement', entityId: id, summary: `+${lines.length} lines` });
    });
  }

  function deleteLine(lineId: number) {
    const l = line(lineId);
    assertOpen(statement(l.statement_id));
    db.run('DELETE FROM bank_statement_lines WHERE id = ?', [lineId]);
  }

  function match(lineId: number, journalLineId: number) {
    const l = line(lineId);
    const s = statement(l.statement_id);
    assertOpen(s);
    if (l.journal_line_id) conflict('bank.already_matched', 'This statement line is already matched');
    const b = db.get<{ account_id: number; amount: number }>(`SELECT l.account_id, ${BANK_AMOUNT('l', 'a')} AS amount FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE l.id = ?`, [journalLineId]);
    if (!b || b.account_id !== s.account_id) fail('bank.wrong_account', 'That entry is not on this bank account');
    if (db.get('SELECT 1 FROM bank_statement_lines WHERE journal_line_id = ?', [journalLineId])) conflict('bank.line_taken', 'That entry is already matched to another statement line');
    if (b!.amount !== l.amount) fail('bank.amount_mismatch', 'The amounts differ', { statement: l.amount, book: b!.amount });
    db.run('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ?', [journalLineId, lineId]);
  }

  function unmatch(lineId: number) {
    const l = line(lineId);
    assertOpen(statement(l.statement_id));
    db.run('UPDATE bank_statement_lines SET journal_line_id = NULL WHERE id = ?', [lineId]);
  }

  /** Pair every unmatched statement line with an uncleared ledger line of the same amount, closest date first. */
  function autoMatch(id: number): number {
    const s = statement(id);
    assertOpen(s);
    const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
    const book = uncleared(s.account_id);
    const open = db.all<StatementLine>('SELECT * FROM bank_statement_lines WHERE statement_id = ? AND journal_line_id IS NULL ORDER BY date, line_no', [id]);
    let n = 0;
    db.tx(() => {
      for (const l of open) {
        let best: { b: BookLine; score: number } | null = null;
        for (const b of book) {
          if (b.amount !== l.amount) continue;
          const d = days(b.date, l.date);
          if (d > MATCH_WINDOW_DAYS) continue;
          const ref = l.reference && (b.reference === l.reference || b.number === l.reference) ? -100 : 0;
          const score = d + ref;
          if (!best || score < best.score) best = { b, score };
        }
        if (best) {
          db.run('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ?', [best.b.id, l.id]);
          book.splice(book.indexOf(best.b), 1);
          n++;
        }
      }
    });
    return n;
  }

  /**
   * A statement line with no entry in the books yet (bank charges, interest, a direct debit):
   * post it against the chosen account and match it in one step.
   */
  function createEntryFor(lineId: number, input: { accountId: number; description: string | null; costCenterId: number | null }, userId: number | null): number {
    const l = line(lineId);
    const s = statement(l.statement_id);
    assertOpen(s);
    if (l.journal_line_id) conflict('bank.already_matched', 'This statement line is already matched');
    const counter = ledger().account(input.accountId);
    if (counter.subtype === 'receivable' || counter.subtype === 'payable') {
      fail('bank.use_payment', 'Money from customers or to suppliers is recorded as a receipt or payment');
    }
    const bank = ledger().account(s.account_id);
    return db.tx(() => {
      const desc = input.description ?? l.description;
      // A foreign-currency account: the statement is in that currency, the books in base at the day's rate.
      const amt = bank.currency ? services.get('fx').toBase(Math.abs(l.amount), services.get('fx').rate(bank.currency, l.date)) : Math.abs(l.amount);
      const bankLine = l.amount > 0 ? { debit: amt, credit: 0 } : { debit: 0, credit: amt };
      const entryId = ledger().createEntry(
        {
          date: l.date,
          reference: l.reference,
          memo: desc,
          lines: [
            { accountId: s.account_id, ...bankLine, description: desc, ...(bank.currency ? { currency: bank.currency, amountFx: l.amount } : {}) },
            { accountId: counter.id, debit: bankLine.credit, credit: bankLine.debit, description: desc, costCenterId: input.costCenterId },
          ],
        },
        { sourceType: 'bank', sourceId: s.id, userId, post: true },
      );
      const jl = db.get<{ id: number }>('SELECT id FROM journal_lines WHERE entry_id = ? AND line_no = 1', [entryId])!;
      db.run('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ?', [jl.id, lineId]);
      audit().log({ userId, action: 'create', entity: 'bank_statement_line', entityId: lineId, summary: `entry ${entryId}` });
      return entryId;
    });
  }

  function summary(id: number) {
    const s = statement(id);
    const t = db.get<{ total: number; lines: number; unmatched: number }>(
      `SELECT COALESCE(SUM(amount), 0) total, COUNT(*) lines, COALESCE(SUM(journal_line_id IS NULL), 0) unmatched
       FROM bank_statement_lines WHERE statement_id = ?`,
      [id],
    )!;
    const book = db.get<{ b: number }>(`SELECT COALESCE(SUM(${BANK_AMOUNT('l', 'a')}), 0) b FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE l.account_id = ? AND l.date <= ?`, [s.account_id, s.date])!.b;
    const unclearedTotal = uncleared(s.account_id, s.date).reduce((x, b) => x + b.amount, 0);
    return {
      linesTotal: t.total,
      lines: t.lines,
      unmatched: t.unmatched,
      /** Opening + lines must equal the closing balance printed on the statement. */
      difference: s.opening_balance + t.total - s.closing_balance,
      bookBalance: book,
      /** Book entries the bank has not shown yet (cheques in the post, deposits in transit). */
      unclearedTotal,
    };
  }

  function reconcile(id: number, userId: number | null) {
    const s = statement(id);
    assertOpen(s);
    const sum = summary(id);
    if (sum.unmatched > 0) fail('bank.unmatched', `${sum.unmatched} statement lines are not matched yet`, { count: sum.unmatched });
    if (sum.difference !== 0) fail('bank.not_balanced', 'Opening balance plus the lines does not equal the closing balance', { difference: sum.difference });
    const earlier = db.get(`SELECT 1 FROM bank_statements WHERE account_id = ? AND status = 'open' AND date < ? AND id <> ?`, [s.account_id, s.date, id]);
    if (earlier) conflict('bank.earlier_open', 'Reconcile the earlier statement first');
    db.tx(() => {
      db.run(`UPDATE bank_statements SET status = 'reconciled', reconciled_at = ? WHERE id = ?`, [nowIso(), id]);
      audit().log({ userId, action: 'reconcile', entity: 'bank_statement', entityId: id, summary: s.date });
    });
  }

  function reopen(id: number, userId: number | null) {
    const s = statement(id);
    if (s.status !== 'reconciled') conflict('bank.not_reconciled', 'This statement is not reconciled');
    if (lastReconciled(s.account_id)?.id !== id) conflict('bank.not_latest', 'Only the latest reconciled statement can be reopened');
    db.tx(() => {
      db.run(`UPDATE bank_statements SET status = 'open', reconciled_at = NULL WHERE id = ?`, [id]);
      audit().log({ userId, action: 'reopen', entity: 'bank_statement', entityId: id, summary: s.date });
    });
  }

  function deleteStatement(id: number, userId: number | null) {
    assertOpen(statement(id));
    db.tx(() => {
      db.run('DELETE FROM bank_statement_lines WHERE statement_id = ?', [id]);
      db.run('DELETE FROM bank_statements WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'bank_statement', entityId: id });
    });
  }

  /** Reversing an entry that a reconciled statement ticked off would silently change history. */
  function guardReversal(entryId: number) {
    const hit = db.get<{ date: string }>(
      `SELECT s.date FROM bank_statement_lines bl
       JOIN bank_statements s ON s.id = bl.statement_id
       JOIN journal_lines jl ON jl.id = bl.journal_line_id
       WHERE jl.entry_id = ? AND s.status = 'reconciled' LIMIT 1`,
      [entryId],
    );
    if (hit) conflict('bank.reconciled_entry', `This entry is part of the bank statement of ${hit.date}, which is reconciled — reopen it first`, { date: hit.date });
  }

  return {
    transfer,
    createTransfer,
    updateTransfer,
    postTransfer,
    voidTransfer,
    deleteTransfer,
    statement,
    lastReconciled,
    uncleared,
    createStatement,
    updateStatement,
    addLines,
    deleteLine,
    match,
    unmatch,
    autoMatch,
    createEntryFor,
    summary,
    reconcile,
    reopen,
    deleteStatement,
    guardReversal,
  };
}
