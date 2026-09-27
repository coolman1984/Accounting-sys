import type { ModuleContext } from '../../kernel/modules.js';
import type {} from '../../contracts/co.js';
import type {} from '../../contracts/fx.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, addMonths, isValidDate, nowIso, today } from '../../kernel/dates.js';
import { isMinor, sum } from '../../kernel/money.js';
import { ACCOUNT_TYPES, SUBTYPES, type AccountType } from './schema.js';
import { DEFAULT_ACCOUNT_KEYS, type DefaultAccountKey, type TemplateAccount } from './chart-template.js';

export interface Account {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  type: AccountType;
  subtype: string;
  parent_id: number | null;
  is_group: number;
  is_active: number;
  description: string | null;
  /** Foreign currency the account is kept in (cash/bank only); null = base currency. */
  currency: string | null;
  /** Cost behaviour for break-even analysis: share of this expense that moves with sales (bp); null = default by subtype. */
  variable_bp: number | null;
  analysis_tag: 'lease' | null;
  created_at: string;
}

export interface AccountInput {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  subtype: string;
  parentId: number | null;
  isGroup: boolean;
  isActive: boolean;
  description: string | null;
  currency?: string | null;
  variableBp?: number | null;
  analysisTag?: 'lease' | null;
}

export interface JournalLineInput {
  accountId: number;
  debit: number;
  credit: number;
  description?: string | null;
  partyId?: number | null;
  /** Controlling dimension (CO module); income and expense lines may carry one. */
  costCenterId?: number | null;
  /** Foreign currency of the line and its signed amount in that currency (+ debit, − credit). */
  currency?: string | null;
  amountFx?: number | null;
}

export interface JournalInput {
  date: string;
  reference?: string | null;
  memo?: string | null;
  lines: JournalLineInput[];
}

export interface EntryOptions {
  /** What produced this entry: manual, opening, sales_invoice, payment … */
  sourceType?: string;
  sourceId?: number | null;
  /** Post immediately (default) or keep as draft. */
  post?: boolean;
  userId: number | null;
}

export interface JournalEntry {
  id: number;
  number: string | null;
  date: string;
  reference: string | null;
  memo: string | null;
  source_type: string;
  source_id: number | null;
  status: 'draft' | 'posted';
  total: number;
  reversal_of_id: number | null;
  reversed_by_id: number | null;
  created_by: number | null;
  created_at: string;
  posted_at: string | null;
  lines: JournalLine[];
}

export interface JournalLine {
  id: number;
  line_no: number;
  account_id: number;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  party_id: number | null;
  cost_center_id: number | null;
  currency: string | null;
  amount_fx: number | null;
  description: string | null;
  debit: number;
  credit: number;
}

export interface FiscalYear {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  closing_entry_id: number | null;
  closed_at: string | null;
}

export interface Movement {
  debit: number;
  credit: number;
}

export interface MovementQuery {
  from?: string | null;
  to?: string | null;
  /** Leave year-end closing entries out (needed by the income statement). */
  excludeClosing?: boolean;
  partyId?: number | null;
}

/** Sources that belong to year-end closing; excluded from P&L-style reports. */
export const CLOSING_SOURCES = ['closing', 'closing_reversal'];

/** Sources whose entries are owned by another document and can't be edited by hand. */
const MANUAL_SOURCES = new Set(['manual', 'opening']);

export type LedgerService = ReturnType<typeof createLedger>;

export function createLedger({ db, services, events, apps }: ModuleContext) {
  const audit = () => services.get('audit');
  const settings = () => services.get('settings');

  // ------------------------------------------------------------------ accounts

  function account(id: number): Account {
    const a = db.get<Account>('SELECT * FROM accounts WHERE id = ?', [id]);
    return a ?? notFound('account', id);
  }

  function hasPostings(id: number): boolean {
    return !!db.get('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', [id]);
  }

  function validateAccount(input: AccountInput, selfId: number | null): void {
    if (!ACCOUNT_TYPES.includes(input.type)) fail('account.invalid_type', 'Invalid account type');
    if (!SUBTYPES[input.type].includes(input.subtype)) {
      fail('account.invalid_subtype', `Subtype "${input.subtype}" is not valid for ${input.type} accounts`);
    }
    const dup = db.get<{ id: number }>('SELECT id FROM accounts WHERE code = ?', [input.code]);
    if (dup && dup.id !== selfId) conflict('account.duplicate_code', `Account code ${input.code} already exists`);
    if (input.parentId != null) {
      const parent = account(input.parentId);
      if (!parent.is_group) fail('account.parent_not_group', 'The parent must be a group account');
      if (parent.type !== input.type) fail('account.parent_type', 'An account must have the same type as its parent');
      if (selfId != null) {
        // Walk up from the new parent: we must never meet ourselves (cycle).
        let cur: number | null = parent.id;
        while (cur != null) {
          if (cur === selfId) fail('account.cycle', 'An account cannot be placed under itself');
          cur = db.get<{ parent_id: number | null }>('SELECT parent_id FROM accounts WHERE id = ?', [cur])?.parent_id ?? null;
        }
      }
    }
    const cur = input.currency ?? null;
    if (cur) {
      if (input.subtype !== 'cash' && input.subtype !== 'bank') fail('account.currency_cash_only', 'Only cash and bank accounts can be kept in a foreign currency');
      if (!services.has('fx')) fail('fx.unavailable', 'Multi-currency is not installed');
      if (!services.get('fx').isForeign(cur)) fail('account.currency_base', 'Leave the currency empty for the base currency');
      services.get('fx').assertCurrency(cur);
      if (selfId != null) {
        const before = account(selfId);
        if (before.currency !== cur && hasPostings(selfId)) fail('account.currency_locked', 'The currency cannot change once the account has transactions');
      }
    } else if (selfId != null) {
      const before = account(selfId);
      if (before.currency && hasPostings(selfId)) fail('account.currency_locked', 'The currency cannot change once the account has transactions');
    }
    if (input.variableBp != null && input.type !== 'expense') fail('account.variable_expense_only', 'Cost behaviour applies to expense accounts');
  }

  const extraCols = (input: AccountInput) => ({
    currency: input.currency ?? null,
    variable_bp: input.type === 'expense' ? input.variableBp ?? null : null,
    analysis_tag: input.analysisTag ?? null,
  });

  function createAccount(input: AccountInput, userId: number | null): number {
    validateAccount(input, null);
    return db.tx(() => {
      const id = db.insert('accounts', {
        code: input.code,
        name_en: input.nameEn,
        name_ar: input.nameAr,
        type: input.type,
        subtype: input.subtype,
        parent_id: input.parentId,
        is_group: input.isGroup,
        is_active: input.isActive,
        description: input.description,
        ...extraCols(input),
        created_at: nowIso(),
      });
      audit().log({ userId, action: 'create', entity: 'account', entityId: id, summary: `${input.code} ${input.nameEn}` });
      return id;
    });
  }

  function updateAccount(id: number, input: AccountInput, userId: number | null): void {
    const cur = account(id);
    validateAccount(input, id);
    const posted = hasPostings(id);
    if (posted && cur.type !== input.type) fail('account.type_locked', 'Account type cannot change once it has transactions');
    if (posted && !cur.is_group && input.isGroup) fail('account.group_locked', 'An account with transactions cannot become a group');
    const hasChildren = !!db.get('SELECT 1 FROM accounts WHERE parent_id = ?', [id]);
    if (hasChildren && !input.isGroup) fail('account.has_children', 'An account with sub-accounts must stay a group');
    if (hasChildren && cur.type !== input.type) fail('account.type_locked', 'Change the sub-accounts first');
    if (!input.isActive && isDefaultAccount(id)) fail('account.in_use', 'This account is used as a default account');
    db.tx(() => {
      db.update('accounts', id, {
        code: input.code,
        name_en: input.nameEn,
        name_ar: input.nameAr,
        type: input.type,
        subtype: input.subtype,
        parent_id: input.parentId,
        is_group: input.isGroup,
        is_active: input.isActive,
        description: input.description,
        ...extraCols(input),
      });
      audit().log({ userId, action: 'update', entity: 'account', entityId: id, data: { before: cur, after: input } });
    });
  }

  function deleteAccount(id: number, userId: number | null): void {
    const cur = account(id);
    if (hasPostings(id)) conflict('account.in_use', 'An account with transactions cannot be deleted — deactivate it instead');
    if (db.get('SELECT 1 FROM accounts WHERE parent_id = ?', [id])) conflict('account.has_children', 'Delete the sub-accounts first');
    if (isDefaultAccount(id)) conflict('account.in_use', 'This account is used as a default account');
    db.tx(() => {
      // Other modules may reference the account (items, taxes, parties): let SQLite refuse via FKs.
      db.run('DELETE FROM accounts WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'account', entityId: id, summary: `${cur.code} ${cur.name_en}` });
    });
  }

  function defaultAccounts(): Record<DefaultAccountKey, number | null> {
    const stored = settings().get<Partial<Record<DefaultAccountKey, number | null>>>('defaultAccounts', {});
    const out = {} as Record<DefaultAccountKey, number | null>;
    for (const k of DEFAULT_ACCOUNT_KEYS) out[k] = stored[k] ?? null;
    return out;
  }

  function isDefaultAccount(id: number): boolean {
    return Object.values(defaultAccounts()).includes(id);
  }

  function defaultAccount(key: DefaultAccountKey): number {
    const id = defaultAccounts()[key];
    if (!id) return fail('account.default_missing', `No default "${key}" account is configured`, { key });
    return id;
  }

  function setDefaultAccounts(map: Partial<Record<DefaultAccountKey, number | null>>, userId: number | null): void {
    for (const [k, id] of Object.entries(map)) {
      if (!DEFAULT_ACCOUNT_KEYS.includes(k as DefaultAccountKey)) fail('account.unknown_default', `Unknown default ${k}`);
      if (id != null) {
        const a = account(id);
        if (a.is_group) fail('account.group_not_allowed', 'Default accounts must be posting accounts');
      }
    }
    db.tx(() => {
      settings().set('defaultAccounts', { ...defaultAccounts(), ...map });
      audit().log({ userId, action: 'update', entity: 'settings', summary: 'default accounts', data: map });
    });
  }

  function seedChart(template: TemplateAccount[]): void {
    const defaults: Partial<Record<DefaultAccountKey, number>> = {};
    const walk = (list: TemplateAccount[], parentId: number | null) => {
      for (const t of list) {
        const id = db.insert('accounts', {
          code: t.code,
          name_en: t.en,
          name_ar: t.ar,
          type: t.type,
          subtype: t.subtype,
          parent_id: parentId,
          is_group: !!t.group,
          is_active: true,
          created_at: nowIso(),
        });
        if (t.role) defaults[t.role] = id;
        if (t.children) walk(t.children, id);
      }
    };
    walk(template, null);
    settings().set('defaultAccounts', { ...defaultAccounts(), ...defaults });
  }

  /**
   * The account a default key points to; when the chart has none, create it (under its usual
   * parent group when that exists) and remember it as the default. Used by features that need
   * an account the company may not have yet (exchange differences, revaluation).
   */
  function ensureDefaultAccount(key: DefaultAccountKey, t: TemplateAccount & { parentCode: string }): number {
    const cur = defaultAccounts()[key];
    if (cur) return cur;
    return db.tx(() => {
      const existing = db.get<{ id: number; subtype: string; is_group: number }>('SELECT id, subtype, is_group FROM accounts WHERE code = ?', [t.code]);
      let id: number;
      if (existing && !existing.is_group && existing.subtype === t.subtype) id = existing.id;
      else {
        // Free code: the template's, or the next one after it.
        let code = t.code;
        for (let n = Number(t.code) + 1; db.get('SELECT 1 FROM accounts WHERE code = ?', [code]); n++) code = String(n);
        const parent = db.get<{ id: number }>('SELECT id FROM accounts WHERE code = ? AND is_group = 1 AND type = ?', [t.parentCode, t.type]);
        id = db.insert('accounts', { code, name_en: t.en, name_ar: t.ar, type: t.type, subtype: t.subtype, parent_id: parent?.id ?? null, is_group: 0, is_active: 1, created_at: nowIso() });
      }
      settings().set('defaultAccounts', { ...defaultAccounts(), [key]: id });
      return id;
    });
  }

  /** Charts made before interest, tax, borrowings and dividends had their own subtypes get those accounts (standard chart only). */
  function upgradeChart(list: (TemplateAccount & { parentCode: string })[]): void {
    for (const t of list) {
      if (db.get('SELECT 1 FROM accounts WHERE subtype = ? LIMIT 1', [t.subtype])) continue;
      const parent = db.get<{ id: number }>('SELECT id FROM accounts WHERE code = ? AND is_group = 1 AND type = ?', [t.parentCode, t.type]);
      if (!parent || db.get('SELECT 1 FROM accounts WHERE code = ?', [t.code])) continue;
      db.insert('accounts', { code: t.code, name_en: t.en, name_ar: t.ar, type: t.type, subtype: t.subtype, parent_id: parent.id, is_group: 0, is_active: 1, created_at: nowIso() });
    }
  }

  // ------------------------------------------------------------ fiscal years

  function fiscalYears(): FiscalYear[] {
    return db.all<FiscalYear>('SELECT * FROM fiscal_years ORDER BY start_date');
  }

  function fiscalYear(id: number): FiscalYear {
    return db.get<FiscalYear>('SELECT * FROM fiscal_years WHERE id = ?', [id]) ?? notFound('fiscal_year', id);
  }

  function createFiscalYear(input: { name?: string; startDate: string; endDate: string }, userId: number | null): number {
    if (!isValidDate(input.startDate) || !isValidDate(input.endDate) || input.endDate < input.startDate) {
      fail('fiscal.invalid_range', 'Invalid fiscal year dates');
    }
    const overlap = db.get('SELECT 1 FROM fiscal_years WHERE start_date <= ? AND end_date >= ?', [input.endDate, input.startDate]);
    if (overlap) conflict('fiscal.overlap', 'Fiscal years cannot overlap');
    const name = input.name?.trim() || defaultYearName(input.startDate, input.endDate);
    return db.tx(() => {
      const id = db.insert('fiscal_years', { name, start_date: input.startDate, end_date: input.endDate, status: 'open' });
      audit().log({ userId, action: 'create', entity: 'fiscal_year', entityId: id, summary: name });
      return id;
    });
  }

  function defaultYearName(start: string, end: string): string {
    return start.slice(0, 4) === end.slice(0, 4) ? `FY ${start.slice(0, 4)}` : `FY ${start.slice(0, 4)}/${end.slice(2, 4)}`;
  }

  /** The year following the last one, 12 months long. */
  function nextYearRange(): { startDate: string; endDate: string } | null {
    const last = db.get<FiscalYear>('SELECT * FROM fiscal_years ORDER BY end_date DESC LIMIT 1');
    if (!last) return null;
    const startDate = addDays(last.end_date, 1);
    return { startDate, endDate: addDays(addMonths(startDate, 12), -1) };
  }

  /** Posting-date guard: lock date, fiscal year exists and is open. */
  function assertPostingDate(date: string): void {
    if (!isValidDate(date)) fail('validation', 'Invalid date');
    const lock = settings().lockDate();
    if (lock && date <= lock) fail('period.locked', `Books are locked up to ${lock}`, { lockDate: lock });
    let fy = db.get<FiscalYear>('SELECT * FROM fiscal_years WHERE start_date <= ? AND end_date >= ?', [date, date]);
    if (!fy) {
      // Friendly: open the next consecutive year automatically when the business moves into it.
      const next = nextYearRange();
      if (next && date >= next.startDate && date <= next.endDate) {
        createFiscalYear(next, null);
        fy = db.get<FiscalYear>('SELECT * FROM fiscal_years WHERE start_date <= ? AND end_date >= ?', [date, date]);
      }
    }
    if (!fy) fail('period.no_fiscal_year', `No fiscal year covers ${date}`, { date });
    if (fy!.status === 'closed') fail('period.closed', `Fiscal year ${fy!.name} is closed`, { fiscalYear: fy!.name });
  }

  // ------------------------------------------------------------------ journal

  /** `mirror`: the lines copy an entry already posted (a reversal) — its dimensions were valid then and must be kept as-is. */
  function validateLines(lines: JournalLineInput[], mirror = false): void {
    if (lines.length === 0) fail('journal.no_lines', 'An entry needs lines');
    lines.forEach((l, i) => {
      if (!isMinor(l.debit) || !isMinor(l.credit) || l.debit < 0 || l.credit < 0) {
        fail('journal.invalid_amount', `Line ${i + 1}: invalid amount`, { line: i + 1 });
      }
      if ((l.debit === 0) === (l.credit === 0)) {
        fail('journal.one_side', `Line ${i + 1}: enter either a debit or a credit`, { line: i + 1 });
      }
      const a = db.get<Account>('SELECT * FROM accounts WHERE id = ?', [l.accountId]);
      if (!a) return fail('journal.unknown_account', `Line ${i + 1}: unknown account`, { line: i + 1 });
      if (a.is_group) fail('journal.group_account', `Line ${i + 1}: ${a.code} is a group account`, { line: i + 1, code: a.code });
      if (!a.is_active) fail('journal.inactive_account', `Line ${i + 1}: ${a.code} is inactive`, { line: i + 1, code: a.code });
      if ((a.subtype === 'receivable' || a.subtype === 'payable') && !l.partyId) {
        fail('journal.party_required', `Line ${i + 1}: ${a.code} needs a customer or supplier`, { line: i + 1, code: a.code });
      }
      if (l.partyId && services.has('parties')) services.get('parties').get(l.partyId);
      if (l.costCenterId && !mirror) {
        // Cost centers belong to the CO module; without it (or switched off) none may be used.
        if (!services.has('costCenters') || !apps.isEnabled('co')) fail('co.unavailable', `Line ${i + 1}: cost centers are not in use`, { line: i + 1 });
        services.get('costCenters').assertUsable(l.costCenterId);
      }
      // A foreign-currency account must know how much foreign money moved, or its balance in that currency is lost.
      if (a.currency && l.amountFx == null && !mirror) {
        fail('fx.amount_required', `Line ${i + 1}: ${a.code} is kept in ${a.currency} — enter the ${a.currency} amount`, { line: i + 1, code: a.code, currency: a.currency });
      }
      if (l.amountFx != null && !l.currency) fail('fx.currency_required', `Line ${i + 1}: foreign amount without a currency`, { line: i + 1 });
      if (l.amountFx && (l.debit > 0) !== (l.amountFx > 0)) fail('fx.sign', `Line ${i + 1}: the foreign amount must be on the same side as the line`, { line: i + 1 });
      if (a.currency && l.currency && l.currency !== a.currency) {
        fail('fx.account_currency', `Line ${i + 1}: ${a.code} is kept in ${a.currency}`, { line: i + 1, code: a.code, currency: a.currency });
      }
    });
  }

  function assertBalanced(lines: JournalLineInput[]): number {
    if (lines.length < 2) fail('journal.min_lines', 'An entry needs at least two lines');
    const dr = sum(lines.map((l) => l.debit));
    const cr = sum(lines.map((l) => l.credit));
    if (dr !== cr) fail('journal.unbalanced', 'Debits must equal credits', { debit: dr, credit: cr, difference: dr - cr });
    if (dr === 0) fail('journal.zero', 'The entry total cannot be zero');
    return dr;
  }

  function writeLines(entryId: number, lines: JournalLineInput[]): void {
    lines.forEach((l, i) =>
      db.insert('journal_lines', {
        entry_id: entryId,
        line_no: i + 1,
        account_id: l.accountId,
        party_id: l.partyId ?? null,
        cost_center_id: l.costCenterId ?? null,
        currency: l.currency ?? null,
        amount_fx: l.amountFx ?? null,
        description: l.description ?? null,
        debit: l.debit,
        credit: l.credit,
      }),
    );
  }

  function createEntry(input: JournalInput, opts: EntryOptions, mirror = false): number {
    validateLines(input.lines, mirror);
    const post = opts.post ?? true;
    if (post) {
      assertBalanced(input.lines);
      assertPostingDate(input.date);
    }
    return db.tx(() => {
      const now = nowIso();
      const id = db.insert('journal_entries', {
        date: input.date,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        source_type: opts.sourceType ?? 'manual',
        source_id: opts.sourceId ?? null,
        status: 'draft',
        total: sum(input.lines.map((l) => l.debit)),
        created_by: opts.userId,
        created_at: now,
        updated_at: now,
      });
      writeLines(id, input.lines);
      if (post) postEntry(id, opts.userId, { silentAudit: true });
      audit().log({
        userId: opts.userId,
        action: post ? 'post' : 'create',
        entity: 'journal_entry',
        entityId: id,
        summary: post ? entryNumber(id) : 'draft',
      });
      return id;
    });
  }

  function entryNumber(id: number): string | null {
    return db.get<{ number: string | null }>('SELECT number FROM journal_entries WHERE id = ?', [id])?.number ?? null;
  }

  function header(id: number): Omit<JournalEntry, 'lines'> {
    return db.get<Omit<JournalEntry, 'lines'>>('SELECT * FROM journal_entries WHERE id = ?', [id]) ?? notFound('journal_entry', id);
  }

  function updateDraft(id: number, input: JournalInput, userId: number | null): void {
    const cur = header(id);
    if (cur.status !== 'draft') conflict('journal.not_draft', 'Only drafts can be edited');
    validateLines(input.lines);
    db.tx(() => {
      db.run('DELETE FROM journal_lines WHERE entry_id = ?', [id]);
      writeLines(id, input.lines);
      db.update('journal_entries', id, {
        date: input.date,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        total: sum(input.lines.map((l) => l.debit)),
        updated_at: nowIso(),
      });
      audit().log({ userId, action: 'update', entity: 'journal_entry', entityId: id });
    });
  }

  function postEntry(id: number, userId: number | null, o: { silentAudit?: boolean } = {}): void {
    const cur = header(id);
    if (cur.status !== 'draft') conflict('journal.not_draft', 'Entry is already posted');
    const lines = db.all<{ account_id: number; party_id: number | null; debit: number; credit: number; currency: string | null; amount_fx: number | null }>(
      'SELECT account_id, party_id, debit, credit, currency, amount_fx FROM journal_lines WHERE entry_id = ? ORDER BY line_no',
      [id],
    ).map((l) => ({ accountId: l.account_id, partyId: l.party_id, debit: l.debit, credit: l.credit, currency: l.currency, amountFx: l.amount_fx }));
    validateLines(lines);
    const total = assertBalanced(lines);
    assertPostingDate(cur.date);
    db.tx(() => {
      const number = services.get('sequences').next('journal');
      db.run(
        `UPDATE journal_entries SET status = 'posted', number = ?, total = ?, posted_by = ?, posted_at = ?, updated_at = ?
         WHERE id = ?`,
        [number, total, userId, nowIso(), nowIso(), id],
      );
      if (!o.silentAudit) audit().log({ userId, action: 'post', entity: 'journal_entry', entityId: id, summary: number });
      events.emit('journal.posted', { entryId: id });
    });
  }

  function reverseEntry(id: number, opts: { date?: string | null; memo?: string | null; sourceType?: string }, userId: number | null): number {
    const cur = entry(id);
    if (cur.status !== 'posted') conflict('journal.not_posted', 'Only posted entries can be reversed');
    if (cur.reversed_by_id) conflict('journal.already_reversed', 'This entry was already reversed');
    if (cur.reversal_of_id) conflict('journal.is_reversal', 'A reversal cannot itself be reversed');
    const date = opts.date ?? cur.date;
    return db.tx(() => {
      const revId = createEntry(
        {
          date,
          reference: cur.number,
          memo: opts.memo ?? `Reversal of ${cur.number}`,
          lines: cur.lines.map((l) => ({
            accountId: l.account_id,
            partyId: l.party_id,
            costCenterId: l.cost_center_id,
            currency: l.currency,
            amountFx: l.amount_fx == null ? null : -l.amount_fx,
            description: l.description,
            debit: l.credit,
            credit: l.debit,
          })),
        },
        { sourceType: opts.sourceType ?? 'reversal', sourceId: cur.source_id, userId, post: false },
        true,
      );
      db.run('UPDATE journal_entries SET reversal_of_id = ? WHERE id = ?', [id, revId]);
      postEntry(revId, userId, { silentAudit: true });
      db.run('UPDATE journal_entries SET reversed_by_id = ? WHERE id = ?', [revId, id]);
      audit().log({ userId, action: 'reverse', entity: 'journal_entry', entityId: id, summary: `${cur.number} → ${entryNumber(revId)}` });
      events.emit('journal.reversed', { entryId: id, reversalId: revId });
      return revId;
    });
  }

  function deleteDraft(id: number, userId: number | null): void {
    const cur = header(id);
    if (cur.status !== 'draft') conflict('journal.not_draft', 'Posted entries cannot be deleted — reverse them instead');
    db.tx(() => {
      db.run('DELETE FROM journal_entries WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'journal_entry', entityId: id });
    });
  }

  function entry(id: number): JournalEntry {
    const h = header(id);
    const lines = db.all<JournalLine>(
      `SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name_en AS account_name_en, a.name_ar AS account_name_ar,
              l.party_id, l.cost_center_id, l.currency, l.amount_fx, l.description, l.debit, l.credit
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ? ORDER BY l.line_no`,
      [id],
    );
    return { ...h, lines };
  }

  function isManual(id: number): boolean {
    return MANUAL_SOURCES.has(header(id).source_type);
  }

  // ------------------------------------------------------- year-end closing

  function closeFiscalYear(id: number, userId: number | null): { closingEntryId: number | null } {
    const fy = fiscalYear(id);
    if (fy.status === 'closed') conflict('fiscal.already_closed', 'This fiscal year is already closed');
    const earlierOpen = db.get('SELECT 1 FROM fiscal_years WHERE end_date < ? AND status = ?', [fy.start_date, 'open']);
    if (earlierOpen) fail('fiscal.previous_open', 'Close the earlier fiscal years first');
    const drafts = db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM journal_entries WHERE status = 'draft' AND date BETWEEN ? AND ?",
      [fy.start_date, fy.end_date],
    )!.n;
    if (drafts > 0) fail('fiscal.drafts_exist', `${drafts} draft entries are dated in this year`, { count: drafts });
    const re = defaultAccount('retainedEarnings');

    return db.tx(() => {
      const rows = db.all<{ account_id: number; net: number }>(
        `SELECT l.account_id, SUM(l.debit) - SUM(l.credit) AS net
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE a.type IN ('income', 'expense') AND l.date BETWEEN ? AND ?
           AND l.source_type NOT IN ('closing', 'closing_reversal')
         GROUP BY l.account_id HAVING net <> 0 ORDER BY a.code`,
        [fy.start_date, fy.end_date],
      );
      let closingEntryId: number | null = null;
      if (rows.length > 0) {
        const lines: JournalLineInput[] = rows.map((r) => ({
          accountId: r.account_id,
          debit: r.net < 0 ? -r.net : 0,
          credit: r.net > 0 ? r.net : 0,
          description: 'Year-end closing',
        }));
        const profit = -sum(rows.map((r) => r.net)); // credit-positive: > 0 means profit
        if (profit !== 0) {
          lines.push({
            accountId: re,
            debit: profit < 0 ? -profit : 0,
            credit: profit > 0 ? profit : 0,
            description: profit > 0 ? 'Net profit for the year' : 'Net loss for the year',
          });
        }
        closingEntryId = createEntry(
          { date: fy.end_date, memo: `Closing of ${fy.name}`, reference: fy.name, lines },
          { sourceType: 'closing', sourceId: fy.id, userId },
        );
      }
      db.update('fiscal_years', id, { status: 'closed', closing_entry_id: closingEntryId, closed_at: nowIso(), closed_by: userId });
      const next = nextYearRange();
      if (next && !db.get('SELECT 1 FROM fiscal_years WHERE start_date > ?', [fy.end_date])) createFiscalYear(next, userId);
      audit().log({ userId, action: 'close', entity: 'fiscal_year', entityId: id, summary: fy.name });
      events.emit('fiscalYear.closed', { fiscalYearId: id });
      return { closingEntryId };
    });
  }

  function reopenFiscalYear(id: number, userId: number | null): void {
    const fy = fiscalYear(id);
    if (fy.status !== 'closed') conflict('fiscal.not_closed', 'This fiscal year is open');
    if (db.get("SELECT 1 FROM fiscal_years WHERE start_date > ? AND status = 'closed'", [fy.start_date])) {
      fail('fiscal.later_closed', 'Reopen the later fiscal years first');
    }
    db.tx(() => {
      db.update('fiscal_years', id, { status: 'open', closing_entry_id: null, closed_at: null, closed_by: null });
      if (fy.closing_entry_id) {
        reverseEntry(fy.closing_entry_id, { date: fy.end_date, memo: `Reopening of ${fy.name}`, sourceType: 'closing_reversal' }, userId);
      }
      audit().log({ userId, action: 'reopen', entity: 'fiscal_year', entityId: id, summary: fy.name });
    });
  }

  // --------------------------------------------------------------- balances

  function movements(q: MovementQuery = {}): Map<number, Movement> {
    const where: string[] = [];
    const p: Record<string, string | number> = {};
    if (q.from) {
      where.push('date >= :from');
      p.from = q.from;
    }
    if (q.to) {
      where.push('date <= :to');
      p.to = q.to;
    }
    if (q.excludeClosing) where.push(`source_type NOT IN ('closing', 'closing_reversal')`);
    if (q.partyId) {
      where.push('party_id = :party');
      p.party = q.partyId;
    }
    const rows = db.all<{ account_id: number; debit: number; credit: number }>(
      `SELECT account_id, SUM(debit) AS debit, SUM(credit) AS credit FROM ledger
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY account_id`,
      p,
    );
    return new Map(rows.map((r) => [r.account_id, { debit: r.debit, credit: r.credit }]));
  }

  return {
    account,
    accountByCode: (code: string) => db.get<Account>('SELECT * FROM accounts WHERE code = ?', [code]),
    accounts: () => db.all<Account>('SELECT * FROM accounts ORDER BY code'),
    hasPostings,
    createAccount,
    updateAccount,
    deleteAccount,
    defaultAccounts,
    defaultAccount,
    setDefaultAccounts,
    seedChart,
    ensureDefaultAccount,
    upgradeChart,
    fiscalYears,
    fiscalYear,
    createFiscalYear,
    closeFiscalYear,
    reopenFiscalYear,
    assertPostingDate,
    createEntry,
    updateDraft,
    postEntry: (id: number, userId: number | null) => postEntry(id, userId),
    reverseEntry,
    deleteDraft,
    entry,
    isManual,
    movements,
    today,
  };
}
