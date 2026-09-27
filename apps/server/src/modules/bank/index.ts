import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { forbidden } from '../../kernel/errors.js';
import { parse, paging, zDate, zId, zMinor, zOptId, zOptText, zPositiveMinor, zText } from '../../kernel/validate.js';
import { bankMigrations } from './schema.js';
import { createBanking, SEQ_TRANSFER, UNCLEARED } from './service.js';

const zTransfer = z.object({
  date: zDate,
  fromAccountId: zId,
  toAccountId: zId,
  amount: zPositiveMinor,
  fee: zMinor.min(0).default(0),
  feeAccountId: zOptId.transform((v) => v ?? null),
  reference: zOptText(100),
  memo: zOptText(300),
  post: z.boolean().default(false),
});

const zLine = z.object({
  date: zDate,
  description: zText(300).min(1),
  reference: zOptText(100),
  amount: zMinor.refine((n) => n !== 0, 'Amount cannot be zero'),
});

const zStatement = z.object({
  accountId: zId,
  date: zDate,
  reference: zOptText(100),
  openingBalance: zMinor.nullish().transform((v) => v ?? null),
  closingBalance: zMinor,
  lines: z.array(zLine).max(5000).default([]),
});

/**
 * Banking (part of the Treasury app): transfers between the company's own cash
 * and bank accounts, and bank reconciliation — import or type the statement,
 * match its lines to the books (automatically where the amount and date agree),
 * post the bank's own charges in one click, and lock the statement once it balances.
 *
 * Talks to the rest only through the ledger service and the `journal.reversed`
 * event; it never writes another module's tables.
 */
export const bankModule: AppModule = {
  id: 'bank',
  dependsOn: ['ledger'],
  permissions: [
    'treasury.transfers.read',
    'treasury.transfers.write',
    'treasury.transfers.post',
    'treasury.statements.read',
    'treasury.statements.write',
    'treasury.statements.post',
  ],
  apps: [{ id: 'treasury', order: 30, permissions: ['treasury'] }],
  migrations: bankMigrations,

  setup(ctx) {
    const bank = createBanking(ctx);
    // Existing companies get the sequence on upgrade; new ones at setup.
    ctx.db.run(`INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES (?, 'TRF-', 1, 5)`, [SEQ_TRANSFER]);
    ctx.events.on('journal.reversed', ({ entryId }) => bank.guardReversal(entryId));
  },

  health({ db }) {
    // A reconciled statement must still add up, and every tick must still point at the same amount.
    const unbalanced = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bank_statements s
       WHERE s.status = 'reconciled'
         AND s.opening_balance + COALESCE((SELECT SUM(amount) FROM bank_statement_lines WHERE statement_id = s.id), 0) <> s.closing_balance`,
    )!.n;
    const mismatched = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bank_statement_lines bl
       JOIN bank_statements s ON s.id = bl.statement_id
       LEFT JOIN ledger l ON l.id = bl.journal_line_id
       WHERE bl.journal_line_id IS NOT NULL AND (l.id IS NULL OR l.account_id <> s.account_id OR l.debit - l.credit <> bl.amount)`,
    )!.n;
    return [
      { id: 'statements', ok: unbalanced === 0, details: { count: unbalanced } },
      { id: 'matches', ok: mismatched === 0, details: { count: mismatched } },
    ];
  },

  routes(r, ctx) {
    const { db } = ctx;
    const bank = createBanking(ctx);

    // ------------------------------------------------------------- overview

    /** Cash & bank accounts: book balance, last reconciled statement, entries the bank has not shown yet. */
    r.get('/bank/accounts', 'auth', ({ user }) => {
      // Needed by both the transfer form and the reconciliation page.
      if (!user.permissions.has('treasury.statements.read') && !user.permissions.has('treasury.transfers.read')) forbidden('treasury.statements.read');
      return db.all(
        `SELECT a.id, a.code, a.name_en, a.name_ar, a.subtype, a.is_active,
                COALESCE((SELECT SUM(debit - credit) FROM ledger l WHERE l.account_id = a.id), 0) AS balance,
                (SELECT date FROM bank_statements s WHERE s.account_id = a.id AND s.status = 'reconciled' ORDER BY date DESC, id DESC LIMIT 1) AS reconciled_to,
                (SELECT closing_balance FROM bank_statements s WHERE s.account_id = a.id AND s.status = 'reconciled' ORDER BY date DESC, id DESC LIMIT 1) AS reconciled_balance,
                (SELECT id FROM bank_statements s WHERE s.account_id = a.id AND s.status = 'open' LIMIT 1) AS open_statement_id,
                (SELECT COUNT(*) FROM ledger l WHERE l.account_id = a.id AND ${UNCLEARED('l')}) AS uncleared
         FROM accounts a WHERE a.subtype IN ('cash', 'bank') AND a.is_group = 0 ORDER BY a.code`,
      );
    });

    // ------------------------------------------------------------ transfers

    r.get('/bank/transfers', 'treasury.transfers.read', ({ query }) => {
      const { limit, offset } = paging(query, 500);
      const rows = db.all(
        `SELECT t.*, f.code AS from_code, f.name_en AS from_name_en, f.name_ar AS from_name_ar,
                o.code AS to_code, o.name_en AS to_name_en, o.name_ar AS to_name_ar
         FROM bank_transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts o ON o.id = t.to_account_id
         ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      const total = db.get<{ n: number }>('SELECT COUNT(*) n FROM bank_transfers')!.n;
      return { rows, total };
    });

    r.get('/bank/transfers/:id', 'treasury.transfers.read', ({ params }) => bank.transfer(Number(params.id)));

    r.post('/bank/transfers', 'treasury.transfers.write', ({ body, user }) => {
      const { post, ...input } = parse(zTransfer, body);
      if (post && !user.permissions.has('treasury.transfers.post')) forbidden('treasury.transfers.post');
      const id = bank.createTransfer(input, user.id);
      if (post) bank.postTransfer(id, user.id);
      return { id };
    });

    r.put('/bank/transfers/:id', 'treasury.transfers.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const { post, ...input } = parse(zTransfer, body);
      if (post && !user.permissions.has('treasury.transfers.post')) forbidden('treasury.transfers.post');
      bank.updateTransfer(id, input, user.id);
      if (post) bank.postTransfer(id, user.id);
      return { id };
    });

    r.post('/bank/transfers/:id/post', 'treasury.transfers.post', ({ params, user }) => (bank.postTransfer(Number(params.id), user.id), { ok: true }));

    r.post('/bank/transfers/:id/void', 'treasury.transfers.post', ({ params, body, user }) => {
      const { date } = parse(z.object({ date: zDate.nullish().transform((v) => v ?? null) }), body ?? {});
      bank.voidTransfer(Number(params.id), date, user.id);
      return { ok: true };
    });

    r.delete('/bank/transfers/:id', 'treasury.transfers.write', ({ params, user }) => (bank.deleteTransfer(Number(params.id), user.id), { ok: true }));

    // -------------------------------------------------------- reconciliation

    r.get('/bank/statements', 'treasury.statements.read', ({ query }) => {
      const accountId = query.accountId ? Number(query.accountId) : null;
      return db.all(
        `SELECT s.*, a.code AS account_code, a.name_en AS account_name_en, a.name_ar AS account_name_ar,
                (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id = s.id) AS lines,
                (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id = s.id AND journal_line_id IS NULL) AS unmatched
         FROM bank_statements s JOIN accounts a ON a.id = s.account_id
         ${accountId ? 'WHERE s.account_id = ?' : ''}
         ORDER BY s.date DESC, s.id DESC`,
        accountId ? [accountId] : [],
      );
    });

    /** Where a new statement starts: the last reconciled closing balance. */
    r.get('/bank/statements/next', 'treasury.statements.read', ({ query }) => {
      const { accountId } = parse(z.object({ accountId: zId }), query);
      const prev = bank.lastReconciled(accountId);
      return { openingBalance: prev?.closing_balance ?? 0, after: prev?.date ?? null, fixed: !!prev };
    });

    r.get('/bank/statements/:id', 'treasury.statements.read', ({ params }) => {
      const id = Number(params.id);
      const s = bank.statement(id);
      const lines = db.all(
        `SELECT bl.*, l.number AS entry_number, l.entry_id, l.date AS entry_date, l.memo AS entry_memo, l.source_type
         FROM bank_statement_lines bl LEFT JOIN ledger l ON l.id = bl.journal_line_id
         WHERE bl.statement_id = ? ORDER BY bl.date, bl.line_no`,
        [id],
      );
      const account = db.get('SELECT id, code, name_en, name_ar FROM accounts WHERE id = ?', [s.account_id]);
      // Candidates are all uncleared book lines — a cheque written last month may clear this month.
      return { ...s, account, lines, book: s.status === 'open' ? bank.uncleared(s.account_id) : [], summary: bank.summary(id) };
    });

    r.post('/bank/statements', 'treasury.statements.write', ({ body, user }) => ({ id: bank.createStatement(parse(zStatement, body), user.id) }));

    r.put('/bank/statements/:id', 'treasury.statements.write', ({ params, body, user }) => {
      const input = parse(z.object({ date: zDate, reference: zOptText(100), closingBalance: zMinor }), body);
      bank.updateStatement(Number(params.id), input, user.id);
      return { ok: true };
    });

    r.post('/bank/statements/:id/lines', 'treasury.statements.write', ({ params, body, user }) => {
      const { lines } = parse(z.object({ lines: z.array(zLine).min(1).max(5000) }), body);
      bank.addLines(Number(params.id), lines, user.id);
      return { ok: true };
    });

    r.delete('/bank/statement-lines/:id', 'treasury.statements.write', ({ params }) => (bank.deleteLine(Number(params.id)), { ok: true }));

    r.post('/bank/statements/:id/auto-match', 'treasury.statements.write', ({ params }) => ({ matched: bank.autoMatch(Number(params.id)) }));

    r.post('/bank/statement-lines/:id/match', 'treasury.statements.write', ({ params, body }) => {
      const { journalLineId } = parse(z.object({ journalLineId: zId }), body);
      bank.match(Number(params.id), journalLineId);
      return { ok: true };
    });

    r.post('/bank/statement-lines/:id/unmatch', 'treasury.statements.write', ({ params }) => (bank.unmatch(Number(params.id)), { ok: true }));

    /** Posting the bank's own line needs both statement rights and journal-posting rights. */
    r.post('/bank/statement-lines/:id/entry', 'treasury.statements.write', ({ params, body, user }) => {
      if (!user.permissions.has('gl.journal.post')) forbidden('gl.journal.post');
      const input = parse(z.object({ accountId: zId, description: zOptText(300), costCenterId: zOptId.transform((v) => v ?? null) }), body);
      return { entryId: bank.createEntryFor(Number(params.id), input, user.id) };
    });

    r.post('/bank/statements/:id/reconcile', 'treasury.statements.post', ({ params, user }) => (bank.reconcile(Number(params.id), user.id), { ok: true }));
    r.post('/bank/statements/:id/reopen', 'treasury.statements.post', ({ params, user }) => (bank.reopen(Number(params.id), user.id), { ok: true }));
    r.delete('/bank/statements/:id', 'treasury.statements.write', ({ params, user }) => (bank.deleteStatement(Number(params.id), user.id), { ok: true }));
  },
};
