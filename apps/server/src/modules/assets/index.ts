import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, endOfMonth, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { JournalLineInput } from '../ledger/service.js';
import { defaultDecliningRate, disposal, schedule, type AssetBasis, type Method } from './engine.js';

interface Category {
  id: number;
  name_en: string;
  name_ar: string;
  asset_account_id: number;
  accum_account_id: number;
  expense_account_id: number;
  method: Method;
  life_months: number;
  residual_bp: number;
  is_active: number;
}
interface Asset {
  id: number;
  code: string;
  name: string;
  category_id: number;
  acquisition_date: string;
  start_month: string;
  cost: number;
  residual: number;
  life_months: number;
  method: Method;
  rate_bp: number | null;
  opening_accumulated: number;
  opening_months: number;
  cost_center_id: number | null;
  location: string | null;
  serial_no: string | null;
  notes: string | null;
  status: 'active' | 'disposed';
  acquisition_entry_id: number | null;
  disposal_date: string | null;
  proceeds: number | null;
  gain: number | null;
  disposal_entry_id: number | null;
}

const month = (date: string) => date.slice(0, 7);
const lastDay = (m: string) => endOfMonth(`${m}-01`);

function createAssets({ db, services, apps }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');
  const category = (id: number) => db.get<Category>('SELECT * FROM asset_categories WHERE id = ?', [id]) ?? notFound('asset_category', id);
  const asset = (id: number) => db.get<Asset>('SELECT * FROM assets WHERE id = ?', [id]) ?? notFound('asset', id);
  const basis = (a: Asset): AssetBasis => ({
    cost: a.cost,
    residual: a.residual,
    lifeMonths: a.life_months,
    method: a.method,
    rateBp: a.rate_bp,
    startMonth: month(a.start_month),
    openingAccumulated: a.opening_accumulated,
    openingMonths: a.opening_months,
  });
  const postedMonths = (assetId: number) => new Set(db.all<{ month: string }>('SELECT month FROM depreciation_lines WHERE asset_id = ?', [assetId]).map((r) => r.month));
  const postedTotal = (assetId: number) => db.get<{ t: number }>('SELECT COALESCE(SUM(amount), 0) t FROM depreciation_lines WHERE asset_id = ?', [assetId])!.t;

  /** Months of the schedule up to `upTo` (YYYY-MM) that are not in the books yet. */
  function pending(a: Asset, upTo: string) {
    const done = postedMonths(a.id);
    return schedule(basis(a)).filter((r) => r.month <= upTo && !done.has(r.month));
  }

  // ----------------------------------------------------------- accounts
  function settingAccount(key: 'gain_account_id' | 'loss_account_id'): number {
    const cur = db.get<Record<string, number | null>>('SELECT * FROM asset_settings WHERE id = 1')![key];
    if (cur) return cur;
    const id =
      key === 'gain_account_id'
        ? ledger().ensureAccount({ code: '4920', en: 'Gain on Disposal of Assets', ar: 'أرباح بيع أصول ثابتة', type: 'income', subtype: 'other_income', parentCode: '4' })
        : ledger().ensureAccount({ code: '5920', en: 'Loss on Disposal of Assets', ar: 'خسائر بيع أصول ثابتة', type: 'expense', subtype: 'other_expense', parentCode: '5' });
    db.run(`UPDATE asset_settings SET ${key} = ? WHERE id = 1`, [id]);
    return id;
  }

  /** Default categories from the standard chart (furniture, vehicles, computers) when there are none. */
  function seedCategories() {
    if (db.get('SELECT 1 FROM asset_categories LIMIT 1')) return;
    const byCode = (code: string) => db.get<{ id: number; subtype: string; is_group: number }>('SELECT id, subtype, is_group FROM accounts WHERE code = ?', [code]);
    const accum = byCode('1290');
    const expense = byCode('5290');
    if (!accum || accum.subtype !== 'accumulated_depreciation' || !expense || expense.subtype !== 'depreciation') return;
    const seed: [string, string, string, number][] = [
      ['1210', 'Furniture & Equipment', 'الأثاث والمعدات', 120],
      ['1220', 'Vehicles', 'السيارات', 60],
      ['1230', 'Computers & Software', 'أجهزة الحاسب والبرامج', 36],
    ];
    for (const [code, en, ar, life] of seed) {
      const acc = byCode(code);
      if (!acc || acc.is_group || acc.subtype !== 'fixed_asset') continue;
      db.insert('asset_categories', { name_en: en, name_ar: ar, asset_account_id: acc.id, accum_account_id: accum.id, expense_account_id: expense.id, method: 'straight_line', life_months: life, residual_bp: 0, is_active: 1 });
    }
  }

  // ---------------------------------------------------------- categories
  const zCategory = z.object({
    nameEn: z.string().trim().min(1).max(100),
    nameAr: z.string().trim().min(1).max(100),
    assetAccountId: zId,
    accumAccountId: zId,
    expenseAccountId: zId,
    method: z.enum(['straight_line', 'declining']).default('straight_line'),
    lifeMonths: z.number().int().min(1).max(1200),
    residualBp: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
  });
  function writeCategory(id: number | null, input: z.infer<typeof zCategory>, userId: number | null): number {
    const check = (accId: number, subtype: string, key: string) => {
      const a = ledger().account(accId);
      if (a.is_group || a.subtype !== subtype) fail('assets.category_account', `${a.code} is not a ${subtype.replace('_', ' ')} account`, { code: a.code, kind: key });
    };
    check(input.assetAccountId, 'fixed_asset', 'asset');
    check(input.accumAccountId, 'accumulated_depreciation', 'accumulated');
    check(input.expenseAccountId, 'depreciation', 'expense');
    const row = {
      name_en: input.nameEn,
      name_ar: input.nameAr,
      asset_account_id: input.assetAccountId,
      accum_account_id: input.accumAccountId,
      expense_account_id: input.expenseAccountId,
      method: input.method,
      life_months: input.lifeMonths,
      residual_bp: input.residualBp,
      is_active: input.isActive ? 1 : 0,
    };
    return db.tx(() => {
      let cid = id;
      if (cid == null) cid = db.insert('asset_categories', row);
      else {
        const cur = category(cid);
        const used = db.get('SELECT 1 FROM assets WHERE category_id = ? AND (acquisition_entry_id IS NOT NULL OR EXISTS (SELECT 1 FROM depreciation_lines d WHERE d.asset_id = assets.id)) LIMIT 1', [cid]);
        if (used && (cur.asset_account_id !== input.assetAccountId || cur.accum_account_id !== input.accumAccountId)) {
          conflict('assets.category_in_use', 'Assets of this category are in the books — its asset and depreciation accounts cannot change');
        }
        db.update('asset_categories', cid, row);
      }
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'asset_category', entityId: cid, summary: input.nameEn });
      return cid;
    });
  }

  // -------------------------------------------------------------- assets
  const zAsset = z.object({
    name: z.string().trim().min(1).max(150),
    categoryId: zId,
    acquisitionDate: zDate,
    /** First month of depreciation (default: the acquisition month). */
    startDate: zDate.nullish().transform((v) => v ?? null),
    cost: z.number().int().positive().max(1e15),
    residual: z.number().int().min(0).max(1e15).default(0),
    lifeMonths: z.number().int().min(1).max(1200),
    method: z.enum(['straight_line', 'declining']),
    rateBp: z.number().int().min(1).max(100000).nullish().transform((v) => v ?? null),
    openingAccumulated: z.number().int().min(0).max(1e15).default(0),
    openingMonths: z.number().int().min(0).max(1200).default(0),
    costCenterId: zOptId.transform((v) => v ?? null),
    location: zOptText(150),
    serialNo: zOptText(100),
    notes: zOptText(2000),
    /** Book the purchase now: debit the asset account, credit this one (bank, supplier, capital…). */
    acquisition: z.object({ counterAccountId: zId, partyId: zOptId.transform((v) => v ?? null) }).nullish().transform((v) => v ?? null),
  });
  type AssetInput = z.infer<typeof zAsset>;

  function checkAsset(input: AssetInput) {
    const c = category(input.categoryId);
    if (!c.is_active) fail('assets.category_inactive', 'This category is inactive');
    if (input.residual >= input.cost) fail('assets.residual', 'The residual value must be below the cost');
    if (input.openingAccumulated > input.cost - input.residual) fail('assets.opening', 'Depreciation already charged cannot exceed cost minus residual value');
    if (input.openingMonths >= input.lifeMonths && input.openingAccumulated < input.cost - input.residual) fail('assets.opening', 'The life already used must be shorter than the useful life');
    if (input.startDate && month(input.startDate) < month(input.acquisitionDate)) fail('assets.start_before', 'Depreciation cannot start before the asset is acquired');
    if (input.costCenterId && (!services.has('costCenters') || !apps.isEnabled('co'))) fail('co.unavailable', 'Cost centers are not in use');
    if (input.costCenterId) services.get('costCenters').assertUsable(input.costCenterId);
  }

  function createAsset(input: AssetInput, userId: number | null): number {
    checkAsset(input);
    const c = category(input.categoryId);
    return db.tx(() => {
      const code = services.get('sequences').next('fixed_asset');
      const id = db.insert('assets', {
        code,
        name: input.name,
        category_id: c.id,
        acquisition_date: input.acquisitionDate,
        start_month: `${month(input.startDate ?? input.acquisitionDate)}-01`,
        cost: input.cost,
        residual: input.residual,
        life_months: input.lifeMonths,
        method: input.method,
        rate_bp: input.method === 'declining' ? input.rateBp ?? defaultDecliningRate(input.lifeMonths) : null,
        opening_accumulated: input.openingAccumulated,
        opening_months: input.openingMonths,
        cost_center_id: input.costCenterId,
        location: input.location,
        serial_no: input.serialNo,
        notes: input.notes,
        status: 'active',
        created_by: userId,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      if (input.acquisition) {
        const counter = ledger().account(input.acquisition.counterAccountId);
        if (counter.id === c.asset_account_id) fail('assets.counter', 'Choose the account the asset was paid from');
        const entry = ledger().createEntry(
          {
            date: input.acquisitionDate,
            reference: code,
            memo: `${code} — ${input.name}`,
            lines: [
              { accountId: c.asset_account_id, debit: input.cost, credit: 0, description: input.name },
              { accountId: counter.id, debit: 0, credit: input.cost, partyId: input.acquisition.partyId, description: input.name },
            ],
          },
          { sourceType: 'asset_acquisition', sourceId: id, userId },
        );
        db.run('UPDATE assets SET acquisition_entry_id = ? WHERE id = ?', [entry, id]);
      }
      audit().log({ userId, action: 'create', entity: 'asset', entityId: id, summary: `${code} ${input.name}` });
      return id;
    });
  }

  /** Before any depreciation everything can change; after, only descriptive fields. */
  function updateAsset(id: number, input: AssetInput, userId: number | null) {
    const a = asset(id);
    if (a.status !== 'active') conflict('assets.disposed', 'A disposed asset cannot be changed');
    const locked = postedTotal(id) > 0 || a.acquisition_entry_id != null;
    db.tx(() => {
      if (!locked) {
        checkAsset({ ...input, acquisition: null });
        db.update('assets', id, {
          category_id: input.categoryId,
          acquisition_date: input.acquisitionDate,
          start_month: `${month(input.startDate ?? input.acquisitionDate)}-01`,
          cost: input.cost,
          residual: input.residual,
          life_months: input.lifeMonths,
          method: input.method,
          rate_bp: input.method === 'declining' ? input.rateBp ?? defaultDecliningRate(input.lifeMonths) : null,
          opening_accumulated: input.openingAccumulated,
          opening_months: input.openingMonths,
        });
      } else if (
        input.cost !== a.cost ||
        input.categoryId !== a.category_id ||
        input.lifeMonths !== a.life_months ||
        input.residual !== a.residual ||
        input.method !== a.method ||
        input.acquisitionDate !== a.acquisition_date
      ) {
        conflict('assets.locked', 'Cost, category, dates and depreciation settings are locked once the asset is in the books');
      }
      if (input.costCenterId !== a.cost_center_id) checkAsset({ ...input, acquisition: null });
      db.update('assets', id, { name: input.name, cost_center_id: input.costCenterId, location: input.location, serial_no: input.serialNo, notes: input.notes, updated_at: nowIso() });
      audit().log({ userId, action: 'update', entity: 'asset', entityId: id, summary: a.code });
    });
  }

  function removeAsset(id: number, userId: number | null) {
    const a = asset(id);
    if (postedTotal(id) > 0 || a.acquisition_entry_id || a.status !== 'active') conflict('assets.in_books', 'This asset is in the books — dispose of it instead');
    db.tx(() => {
      db.run('DELETE FROM assets WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'asset', entityId: id, summary: a.code });
    });
  }

  // --------------------------------------------------------- depreciation
  function preview(m: string) {
    const rows: { asset: Asset; category: Category; months: { month: string; amount: number }[]; amount: number }[] = [];
    for (const a of db.all<Asset>(`SELECT * FROM assets WHERE status = 'active' AND start_month <= ? ORDER BY code`, [`${m}-01`])) {
      const p = pending(a, m);
      if (!p.length) continue;
      rows.push({ asset: a, category: category(a.category_id), months: p.map((x) => ({ month: x.month, amount: x.amount })), amount: p.reduce((s, x) => s + x.amount, 0) });
    }
    return rows;
  }

  /** Book depreciation for month `m` (catching up earlier months not yet charged) in one entry. */
  function run(m: string, userId: number | null): { runId: number; entryId: number | null; total: number } {
    const last = db.get<{ month: string }>('SELECT month FROM depreciation_runs ORDER BY month DESC LIMIT 1');
    if (last && last.month >= m) conflict('assets.run_exists', `Depreciation is already booked up to ${last.month}`, { month: last.month });
    const rows = preview(m);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return db.tx(() => {
      let entryId: number | null = null;
      const runId = db.insert('depreciation_runs', { month: m, entry_id: null, total, assets: rows.length, created_by: userId, created_at: nowIso() });
      if (total > 0) {
        const byKey = new Map<string, JournalLineInput>();
        const add = (accountId: number, cc: number | null, debit: number, credit: number, description: string) => {
          const k = `${accountId}:${cc ?? ''}:${debit > 0 ? 'd' : 'c'}`;
          const cur = byKey.get(k) ?? { accountId, costCenterId: cc, debit: 0, credit: 0, description };
          cur.debit += debit;
          cur.credit += credit;
          byKey.set(k, cur);
        };
        for (const r of rows) {
          add(r.category.expense_account_id, r.asset.cost_center_id, r.amount, 0, `Depreciation ${m}`);
          add(r.category.accum_account_id, null, 0, r.amount, `Depreciation ${m}`);
        }
        entryId = ledger().createEntry({ date: lastDay(m), reference: `DEP ${m}`, memo: `Depreciation ${m}`, lines: [...byKey.values()] }, { sourceType: 'depreciation', sourceId: runId, userId });
        db.run('UPDATE depreciation_runs SET entry_id = ? WHERE id = ?', [entryId, runId]);
      }
      for (const r of rows) for (const x of r.months) db.insert('depreciation_lines', { asset_id: r.asset.id, month: x.month, amount: x.amount, run_id: runId, disposal: 0 });
      audit().log({ userId, action: 'post', entity: 'depreciation_run', entityId: runId, summary: `${m}: ${total}` });
      return { runId, entryId, total };
    });
  }

  function undoRun(runId: number, userId: number | null) {
    const r = db.get<{ id: number; month: string; entry_id: number | null }>('SELECT * FROM depreciation_runs WHERE id = ?', [runId]) ?? notFound('depreciation_run', runId);
    const last = db.get<{ id: number }>('SELECT id FROM depreciation_runs ORDER BY month DESC LIMIT 1')!;
    if (last.id !== r.id) conflict('assets.not_last_run', 'Only the latest depreciation run can be undone');
    const firstMonth = db.get<{ m: string }>('SELECT MIN(month) m FROM depreciation_lines WHERE run_id = ?', [r.id])?.m ?? r.month;
    if (db.get(`SELECT 1 FROM assets WHERE status = 'disposed' AND substr(disposal_date, 1, 7) >= ? LIMIT 1`, [firstMonth])) {
      conflict('assets.disposed_after', 'An asset was disposed of after this run — undo that disposal first');
    }
    db.tx(() => {
      if (r.entry_id) ledger().reverseEntry(r.entry_id, { date: lastDay(r.month), memo: `Undo depreciation ${r.month}` }, userId);
      db.run('DELETE FROM depreciation_lines WHERE run_id = ?', [r.id]);
      db.run('DELETE FROM depreciation_runs WHERE id = ?', [r.id]);
      audit().log({ userId, action: 'reverse', entity: 'depreciation_run', entityId: r.id, summary: r.month });
    });
  }

  // ------------------------------------------------------------- disposal
  function dispose(id: number, input: { date: string; proceeds: number; proceedsAccountId: number | null; partyId: number | null; notes: string | null }, userId: number | null) {
    const a = asset(id);
    if (a.status !== 'active') conflict('assets.disposed', 'This asset is already disposed of');
    if (input.date < a.acquisition_date) fail('assets.dispose_before', 'An asset cannot be disposed of before it is acquired');
    if (input.proceeds > 0 && !input.proceedsAccountId) fail('assets.proceeds_account', 'Choose where the sale money went');
    const c = category(a.category_id);
    const catchUp = pending(a, month(input.date));
    const charge = catchUp.reduce((s, x) => s + x.amount, 0);
    const accumulated = a.opening_accumulated + postedTotal(id) + charge;
    const { gain } = disposal(a.cost, accumulated, input.proceeds);
    const lines: JournalLineInput[] = [];
    const net = new Map<number, number>();
    const add = (acc: number, amt: number) => net.set(acc, (net.get(acc) ?? 0) + amt);
    if (charge > 0) {
      lines.push({ accountId: c.expense_account_id, costCenterId: a.cost_center_id, debit: charge, credit: 0, description: `Depreciation to disposal` });
      add(c.accum_account_id, -charge);
    }
    add(c.accum_account_id, accumulated);
    add(c.asset_account_id, -a.cost);
    for (const [acc, amt] of net) if (amt !== 0) lines.push({ accountId: acc, debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, description: a.name });
    if (input.proceeds > 0) lines.push({ accountId: input.proceedsAccountId!, partyId: input.partyId, debit: input.proceeds, credit: 0, description: a.name });
    if (gain > 0) lines.push({ accountId: settingAccount('gain_account_id'), debit: 0, credit: gain, description: a.name });
    if (gain < 0) lines.push({ accountId: settingAccount('loss_account_id'), debit: -gain, credit: 0, description: a.name });
    db.tx(() => {
      const entryId = ledger().createEntry({ date: input.date, reference: a.code, memo: `Disposal ${a.code} — ${a.name}`, lines }, { sourceType: 'asset_disposal', sourceId: id, userId });
      for (const x of catchUp) db.insert('depreciation_lines', { asset_id: id, month: x.month, amount: x.amount, run_id: null, disposal: 1 });
      db.update('assets', id, { status: 'disposed', disposal_date: input.date, proceeds: input.proceeds, gain, disposal_entry_id: entryId, notes: input.notes ?? a.notes, updated_at: nowIso() });
      audit().log({ userId, action: 'dispose', entity: 'asset', entityId: id, summary: `${a.code} gain ${gain}` });
    });
  }

  function undoDisposal(id: number, userId: number | null) {
    const a = asset(id);
    if (a.status !== 'disposed') conflict('assets.not_disposed', 'This asset is not disposed of');
    db.tx(() => {
      ledger().reverseEntry(a.disposal_entry_id!, { date: a.disposal_date!, memo: `Undo disposal ${a.code}` }, userId);
      db.run('DELETE FROM depreciation_lines WHERE asset_id = ? AND disposal = 1', [id]);
      db.run(`UPDATE assets SET status = 'active', disposal_date = NULL, proceeds = NULL, gain = NULL, disposal_entry_id = NULL, updated_at = ? WHERE id = ?`, [nowIso(), id]);
      audit().log({ userId, action: 'reverse', entity: 'asset_disposal', entityId: id, summary: a.code });
    });
  }

  // --------------------------------------------------------------- views
  function register(asOf: string) {
    const m = month(asOf);
    return db
      .all<Asset & { category_en: string; category_ar: string; charged: number }>(
        `SELECT a.*, c.name_en AS category_en, c.name_ar AS category_ar,
                COALESCE((SELECT SUM(d.amount) FROM depreciation_lines d WHERE d.asset_id = a.id AND d.month <= ?), 0) AS charged
         FROM assets a JOIN asset_categories c ON c.id = a.category_id ORDER BY a.code`,
        [m],
      )
      .map((a) => {
        const accumulated = a.opening_accumulated + a.charged;
        return { ...a, accumulated, book_value: a.status === 'disposed' ? 0 : a.cost - accumulated, fully_depreciated: a.cost - accumulated <= a.residual };
      });
  }

  function view(id: number) {
    const a = asset(id);
    const c = category(a.category_id);
    const posted = new Map(db.all<{ month: string; amount: number; run_id: number | null; disposal: number }>('SELECT month, amount, run_id, disposal FROM depreciation_lines WHERE asset_id = ?', [id]).map((r) => [r.month, r]));
    const rows = schedule(basis(a)).map((r) => ({ ...r, posted: posted.has(r.month), disposal: !!posted.get(r.month)?.disposal }));
    const cut = a.disposal_date ? month(a.disposal_date) : null;
    const accumulated = a.opening_accumulated + [...posted.values()].reduce((s, x) => s + x.amount, 0);
    return {
      ...a,
      category: c,
      accumulated,
      book_value: a.status === 'disposed' ? 0 : a.cost - accumulated,
      schedule: cut ? rows.filter((r) => r.month <= cut) : rows,
      monthly: rows[0]?.amount ?? 0,
    };
  }

  /** IAS 16 reconciliation of cost and accumulated depreciation per category for [from, to]. */
  function rollForward(from: string, to: string) {
    const fm = month(from);
    const tm = month(to);
    const cats = db.all<Category>('SELECT * FROM asset_categories ORDER BY name_en');
    const list = db.all<Asset>('SELECT * FROM assets');
    const lines = db.all<{ asset_id: number; month: string; amount: number }>('SELECT asset_id, month, amount FROM depreciation_lines');
    const accAt = (a: Asset, beforeMonth: string, inclusive: boolean) =>
      a.opening_accumulated + lines.filter((l) => l.asset_id === a.id && (inclusive ? l.month <= beforeMonth : l.month < beforeMonth)).reduce((s, l) => s + l.amount, 0);
    const inBooksAt = (a: Asset, date: string, strictDisposal: boolean) => a.acquisition_date <= date && (!a.disposal_date || (strictDisposal ? a.disposal_date > date : a.disposal_date >= date));
    const rows = cats.map((c) => {
      const r = { costOpening: 0, additions: 0, disposals: 0, costClosing: 0, accOpening: 0, charge: 0, accAdditions: 0, accDisposals: 0, accClosing: 0 };
      const dayBefore = addDays(from, -1);
      // Only assets in the books at some point of the period take part (acquired by `to`, not gone before `from`).
      for (const a of list.filter((x) => x.category_id === c.id && x.acquisition_date <= to && (!x.disposal_date || x.disposal_date >= from))) {
        if (inBooksAt(a, dayBefore, true)) {
          r.costOpening += a.cost;
          r.accOpening += accAt(a, fm, false);
        } else {
          r.additions += a.cost;
          // An asset brought in part-depreciated arrives with that depreciation.
          r.accAdditions += a.opening_accumulated + lines.filter((l) => l.asset_id === a.id && l.month < fm).reduce((s, l) => s + l.amount, 0);
        }
        r.charge += lines.filter((l) => l.asset_id === a.id && l.month >= fm && l.month <= tm).reduce((s, l) => s + l.amount, 0);
        if (a.disposal_date && a.disposal_date <= to) {
          r.disposals += a.cost;
          r.accDisposals += accAt(a, month(a.disposal_date), true);
        } else {
          r.costClosing += a.cost;
          r.accClosing += accAt(a, tm, true);
        }
      }
      return { id: c.id, name_en: c.name_en, name_ar: c.name_ar, ...r, nbvOpening: r.costOpening - r.accOpening, nbvClosing: r.costClosing - r.accClosing };
    });
    const keys = ['costOpening', 'additions', 'disposals', 'costClosing', 'accOpening', 'charge', 'accAdditions', 'accDisposals', 'accClosing', 'nbvOpening', 'nbvClosing'] as const;
    const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as Record<(typeof keys)[number], number>;
    return { from, to, rows: rows.filter((r) => keys.some((k) => r[k] !== 0)), totals };
  }

  return { category, asset, seedCategories, zCategory, writeCategory, zAsset, createAsset, updateAsset, removeAsset, preview, run, undoRun, dispose, undoDisposal, register, view, rollForward };
}

export const assetsModule: AppModule = {
  id: 'assets',
  dependsOn: ['ledger'],
  permissions: ['assets.register.read', 'assets.register.write', 'assets.depreciation.post', 'assets.reports.read'],
  apps: [{ id: 'assets', order: 55, permissions: ['assets'] }],
  roles: [{ id: 'asset_accountant', permissions: ['assets.*', 'gl.accounts.read', 'gl.reports.read'] }],
  health({ db }) {
    const over = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM assets a WHERE a.opening_accumulated + COALESCE((SELECT SUM(amount) FROM depreciation_lines d WHERE d.asset_id = a.id), 0) > a.cost - a.residual`,
    )!.n;
    return [{ id: 'not_over_depreciated', ok: over === 0, details: { count: over } }];
  },
  migrations: [
    {
      id: '001_assets',
      up: `
        CREATE TABLE asset_categories (
          id                 INTEGER PRIMARY KEY,
          name_en            TEXT NOT NULL,
          name_ar            TEXT NOT NULL,
          asset_account_id   INTEGER NOT NULL REFERENCES accounts(id),
          accum_account_id   INTEGER NOT NULL REFERENCES accounts(id),
          expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
          method             TEXT NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line', 'declining')),
          life_months        INTEGER NOT NULL CHECK (life_months > 0),
          residual_bp        INTEGER NOT NULL DEFAULT 0,
          is_active          INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE assets (
          id                   INTEGER PRIMARY KEY,
          code                 TEXT NOT NULL UNIQUE,
          name                 TEXT NOT NULL,
          category_id          INTEGER NOT NULL REFERENCES asset_categories(id),
          acquisition_date     TEXT NOT NULL,
          start_month          TEXT NOT NULL,                  -- first day of the first depreciation month
          cost                 INTEGER NOT NULL CHECK (cost > 0),
          residual             INTEGER NOT NULL DEFAULT 0 CHECK (residual >= 0),
          life_months          INTEGER NOT NULL CHECK (life_months > 0),
          method               TEXT NOT NULL CHECK (method IN ('straight_line', 'declining')),
          rate_bp              INTEGER,
          opening_accumulated  INTEGER NOT NULL DEFAULT 0,
          opening_months       INTEGER NOT NULL DEFAULT 0,
          cost_center_id       INTEGER,
          location             TEXT,
          serial_no            TEXT,
          notes                TEXT,
          status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
          acquisition_entry_id INTEGER REFERENCES journal_entries(id),
          disposal_date        TEXT,
          proceeds             INTEGER,
          gain                 INTEGER,
          disposal_entry_id    INTEGER REFERENCES journal_entries(id),
          created_by           INTEGER REFERENCES users(id),
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );
        CREATE TABLE depreciation_runs (
          id         INTEGER PRIMARY KEY,
          month      TEXT NOT NULL UNIQUE,                     -- YYYY-MM
          entry_id   INTEGER REFERENCES journal_entries(id),
          total      INTEGER NOT NULL DEFAULT 0,
          assets     INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        -- One line per asset and month charged (by a run, or at disposal).
        CREATE TABLE depreciation_lines (
          id       INTEGER PRIMARY KEY,
          asset_id INTEGER NOT NULL REFERENCES assets(id),
          month    TEXT NOT NULL,
          amount   INTEGER NOT NULL,
          run_id   INTEGER REFERENCES depreciation_runs(id),
          disposal INTEGER NOT NULL DEFAULT 0,
          UNIQUE (asset_id, month)
        );
        CREATE TABLE asset_settings (
          id              INTEGER PRIMARY KEY CHECK (id = 1),
          gain_account_id INTEGER REFERENCES accounts(id),
          loss_account_id INTEGER REFERENCES accounts(id)
        );
        INSERT INTO asset_settings (id) VALUES (1);
      `,
    },
  ],

  setup(ctx) {
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('fixed_asset', 'FA-', 1, 5)");
  },

  routes(r, ctx) {
    const { db } = ctx;
    const fa = createAssets(ctx);

    r.get('/assets/categories', 'assets.register.read', () => {
      fa.seedCategories();
      return db.all('SELECT * FROM asset_categories ORDER BY is_active DESC, name_en');
    });
    r.post('/assets/categories', 'assets.register.write', ({ body, user }) => ({ id: fa.writeCategory(null, parse(fa.zCategory, body), user.id) }));
    r.put('/assets/categories/:id', 'assets.register.write', ({ params, body, user }) => {
      fa.category(Number(params.id));
      return { id: fa.writeCategory(Number(params.id), parse(fa.zCategory, body), user.id) };
    });

    r.get('/assets', 'assets.register.read', ({ query }) => fa.register(parse(z.object({ asOf: zDate.default(today()) }), query).asOf));

    // Depreciation (before /assets/:id).
    r.get('/assets/depreciation/runs', 'assets.register.read', () =>
      db.all(`SELECT r.*, e.number AS entry_number FROM depreciation_runs r LEFT JOIN journal_entries e ON e.id = r.entry_id ORDER BY r.month DESC`),
    );
    const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month as YYYY-MM');
    r.get('/assets/depreciation/preview', 'assets.register.read', ({ query }) => {
      const m = parse(z.object({ month: zMonth.default(today().slice(0, 7)) }), query).month;
      const rows = fa.preview(m);
      return {
        month: m,
        rows: rows.map((x) => ({ id: x.asset.id, code: x.asset.code, name: x.asset.name, category_en: x.category.name_en, category_ar: x.category.name_ar, months: x.months, amount: x.amount })),
        total: rows.reduce((s, x) => s + x.amount, 0),
        last: db.get<{ month: string }>('SELECT month FROM depreciation_runs ORDER BY month DESC LIMIT 1')?.month ?? null,
      };
    });
    r.post('/assets/depreciation/run', 'assets.depreciation.post', ({ body, user }) => fa.run(parse(z.object({ month: zMonth }), body).month, user.id));
    r.post('/assets/depreciation/runs/:id/undo', 'assets.depreciation.post', ({ params, user }) => {
      fa.undoRun(Number(params.id), user.id);
      return { ok: true };
    });

    r.get('/assets/report', 'assets.reports.read', ({ query }) => {
      const y = today().slice(0, 4);
      const q = parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(today()) }), query);
      if (q.from > q.to) fail('validation', 'The start date must come before the end date');
      return fa.rollForward(q.from, q.to);
    });

    r.get('/assets/:id', 'assets.register.read', ({ params }) => fa.view(Number(params.id)));
    r.post('/assets', 'assets.register.write', ({ body, user }) => ({ id: fa.createAsset(parse(fa.zAsset, body), user.id) }));
    r.put('/assets/:id', 'assets.register.write', ({ params, body, user }) => {
      fa.updateAsset(Number(params.id), parse(fa.zAsset, body), user.id);
      return { ok: true };
    });
    r.delete('/assets/:id', 'assets.register.write', ({ params, user }) => {
      fa.removeAsset(Number(params.id), user.id);
      return { ok: true };
    });
    r.post('/assets/:id/dispose', 'assets.depreciation.post', ({ params, body, user }) => {
      const q = parse(
        z.object({ date: zDate, proceeds: z.number().int().min(0).max(1e15).default(0), proceedsAccountId: zOptId.transform((v) => v ?? null), partyId: zOptId.transform((v) => v ?? null), notes: zOptText(1000) }),
        body,
      );
      fa.dispose(Number(params.id), q, user.id);
      return fa.view(Number(params.id));
    });
    r.post('/assets/:id/undo-disposal', 'assets.depreciation.post', ({ params, user }) => {
      fa.undoDisposal(Number(params.id), user.id);
      return { ok: true };
    });
  },
};

