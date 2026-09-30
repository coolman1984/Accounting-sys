import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import { allowed, monthFraction, orderVariances, overheadVariances, standardCost, type Standard } from './engine.js';
import { consumeProduction, gmesWipMigration } from './gmes.js';

interface Bom {
  id: number;
  item_id: number;
  name: string;
  output_qty: number;
  labour_hours: number;
  labour_rate: number;
  var_overhead_rate: number;
  fixed_overhead_rate: number;
  is_active: number;
  notes: string | null;
}
interface BomLine {
  id: number;
  bom_id: number;
  line_no: number;
  item_id: number;
  qty: number;
  scrap_bp: number;
  std_cost: number;
}
interface Order {
  id: number;
  number: string;
  bom_id: number;
  item_id: number;
  planned_qty: number;
  output_qty: number;
  date: string;
  warehouse_id: number;
  output_warehouse_id: number;
  status: 'draft' | 'done' | 'void';
  labour_hours: number;
  labour_cost: number | null;
  materials_cost: number;
  labour_applied: number;
  overhead_applied: number;
  total_cost: number;
  std: string;
  output_lots: string | null;
  journal_entry_id: number | null;
  void_entry_id: number | null;
  notes: string | null;
}
interface OrderLine {
  id: number;
  order_id: number;
  line_no: number;
  item_id: number;
  std_qty: number;
  qty: number;
  actual_cost: number;
  lots: string | null;
}
interface Settings {
  labour_account_id: number | null;
  overhead_account_id: number | null;
  budget_fixed_overhead: number;
  overhead_accounts: string;
}

const zQty = z.number().int().min(0).max(1e12);
const zLots = z.array(z.object({ lotNo: z.string().trim().min(1).max(64), expiry: zDate.nullish(), qty: z.number().int().positive() })).max(500).nullish().transform((v) => v ?? null);

function createManufacturing({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const catalog = () => services.get('catalog');
  const inventory = () => services.get('inventory');
  const audit = () => services.get('audit');

  const bom = (id: number) => db.get<Bom>('SELECT * FROM boms WHERE id = ?', [id]) ?? notFound('bom', id);
  const bomLines = (id: number) => db.all<BomLine>('SELECT * FROM bom_lines WHERE bom_id = ? ORDER BY line_no', [id]);
  const order = (id: number) => db.get<Order>('SELECT * FROM production_orders WHERE id = ?', [id]) ?? notFound('production_order', id);
  const orderLines = (id: number) => db.all<OrderLine>('SELECT * FROM production_order_lines WHERE order_id = ? ORDER BY line_no', [id]);
  const settings = () => db.get<Settings>('SELECT * FROM mfg_settings WHERE id = 1')!;

  const standardOf = (b: Bom, lines: BomLine[]): Standard => ({
    outputQty: b.output_qty,
    labourHours: b.labour_hours,
    labourRate: b.labour_rate,
    varOverheadRate: b.var_overhead_rate,
    fixedOverheadRate: b.fixed_overhead_rate,
    components: lines.map((l) => ({ itemId: l.item_id, qty: l.qty, scrapBp: l.scrap_bp, stdCost: l.std_cost })),
  });

  // --------------------------------------------------------------- accounts
  /** The "absorbed" accounts (credit-balance costs of sales) that receive labour and overhead applied to products. */
  function absorbedAccount(key: 'labour_account_id' | 'overhead_account_id', userId: number | null): number {
    const cur = settings()[key];
    if (cur) return cur;
    const cogs = ledger().account(ledger().defaultAccount('cogs'));
    const t =
      key === 'labour_account_id'
        ? { code: '5170', nameEn: 'Production Labour Absorbed', nameAr: 'أجور إنتاج محمّلة على المنتجات' }
        : { code: '5180', nameEn: 'Production Overhead Absorbed', nameAr: 'تكاليف صناعية غير مباشرة محمّلة' };
    let code = t.code;
    while (ledger().accountByCode(code)) code = code + '1';
    const id = ledger().createAccount({ code, nameEn: t.nameEn, nameAr: t.nameAr, type: 'expense', subtype: cogs.subtype, parentId: cogs.parent_id, isGroup: false, isActive: true, description: null }, userId);
    db.run(`UPDATE mfg_settings SET ${key} = ? WHERE id = 1`, [id]);
    return id;
  }

  // ------------------------------------------------------------------ BOMs
  const zBom = z.object({
    itemId: zId,
    name: z.string().trim().min(1).max(120),
    outputQty: z.number().int().positive().max(1e12),
    labourHours: zQty.default(0),
    labourRate: zQty.default(0),
    varOverheadRate: zQty.default(0),
    fixedOverheadRate: zQty.default(0),
    isActive: z.boolean().default(true),
    notes: zOptText(1000),
    lines: z
      .array(z.object({ itemId: zId, qty: z.number().int().positive().max(1e12), scrapBp: z.number().int().min(0).max(10000).default(0), stdCost: zQty.nullish().transform((v) => v ?? null) }))
      .min(1)
      .max(300),
  });
  type BomInput = z.infer<typeof zBom>;

  function checkBom(input: BomInput) {
    const out = catalog().item(input.itemId);
    if (!catalog().isStockItem(out)) fail('mfg.not_stock_item', `${out.sku} is not kept in stock`, { sku: out.sku });
    const seen = new Set<number>();
    input.lines.forEach((l, i) => {
      const it = catalog().item(l.itemId);
      if (l.itemId === input.itemId) fail('mfg.self_component', `Line ${i + 1}: a product cannot be made from itself`, { line: i + 1 });
      if (!catalog().isStockItem(it)) fail('mfg.component_not_stock', `Line ${i + 1}: ${it.sku} is not kept in stock`, { line: i + 1, sku: it.sku });
      if (seen.has(l.itemId)) fail('mfg.duplicate_component', `Line ${i + 1}: ${it.sku} appears twice`, { line: i + 1, sku: it.sku });
      seen.add(l.itemId);
    });
  }

  function writeBom(id: number | null, input: BomInput, userId: number | null): number {
    checkBom(input);
    return db.tx(() => {
      const row = {
        item_id: input.itemId,
        name: input.name,
        output_qty: input.outputQty,
        labour_hours: input.labourHours,
        labour_rate: input.labourRate,
        var_overhead_rate: input.varOverheadRate,
        fixed_overhead_rate: input.fixedOverheadRate,
        is_active: input.isActive ? 1 : 0,
        notes: input.notes,
        updated_at: nowIso(),
      };
      let bid = id;
      if (bid == null) bid = db.insert('boms', { ...row, created_by: userId, created_at: nowIso() });
      else {
        const cur = bom(bid);
        if (cur.item_id !== input.itemId && db.get('SELECT 1 FROM production_orders WHERE bom_id = ? LIMIT 1', [bid])) conflict('mfg.bom_used', 'This recipe has orders — its product cannot change');
        db.update('boms', bid, row);
        db.run('DELETE FROM bom_lines WHERE bom_id = ?', [bid]);
      }
      input.lines.forEach((l, i) =>
        db.insert('bom_lines', { bom_id: bid, line_no: i + 1, item_id: l.itemId, qty: l.qty, scrap_bp: l.scrapBp, std_cost: l.stdCost ?? inventory().unitCost(l.itemId) }),
      );
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'bom', entityId: bid, summary: input.name });
      return bid;
    });
  }

  function bomView(id: number) {
    const b = bom(id);
    const lines = db.all<BomLine & { sku: string; name_en: string; name_ar: string; current_cost: number }>(
      `SELECT l.*, i.sku, i.name_en, i.name_ar FROM bom_lines l JOIN items i ON i.id = l.item_id WHERE l.bom_id = ? ORDER BY l.line_no`,
      [id],
    ).map((l) => ({ ...l, current_cost: inventory().unitCost(l.item_id) }));
    const item = catalog().item(b.item_id);
    const std = standardCost(standardOf(b, lines));
    const current = standardCost(standardOf(b, lines.map((l) => ({ ...l, std_cost: l.current_cost }))));
    return { ...b, sku: item.sku, name_en: item.name_en, name_ar: item.name_ar, lines, standard: std, current };
  }

  // ---------------------------------------------------------------- orders
  function createOrder(input: { bomId: number; plannedQty: number; date: string; warehouseId: number; outputWarehouseId: number | null; notes: string | null }, userId: number | null): number {
    const b = bom(input.bomId);
    if (!b.is_active) fail('mfg.bom_inactive', 'This recipe is inactive');
    inventory().warehouse(input.warehouseId);
    const lines = bomLines(b.id);
    const std = standardOf(b, lines);
    const allow = allowed(std, input.plannedQty);
    return db.tx(() => {
      const number = services.get('sequences').next('production_order');
      const id = db.insert('production_orders', {
        number,
        bom_id: b.id,
        item_id: b.item_id,
        planned_qty: input.plannedQty,
        output_qty: input.plannedQty,
        date: input.date,
        warehouse_id: input.warehouseId,
        output_warehouse_id: input.outputWarehouseId ?? input.warehouseId,
        status: 'draft',
        labour_hours: allow.hours,
        labour_cost: null,
        std: JSON.stringify(std),
        notes: input.notes,
        created_by: userId,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      allow.components.forEach((c, i) => db.insert('production_order_lines', { order_id: id, line_no: i + 1, item_id: c.itemId, std_qty: c.qty, qty: c.qty }));
      audit().log({ userId, action: 'create', entity: 'production_order', entityId: id, summary: number });
      return id;
    });
  }

  const zOrderUpdate = z.object({
    date: zDate,
    warehouseId: zId,
    outputWarehouseId: zId,
    outputQty: z.number().int().positive().max(1e12),
    labourHours: zQty,
    labourCost: zQty.nullish().transform((v) => v ?? null),
    notes: zOptText(1000),
    outputLots: zLots,
    lines: z.array(z.object({ itemId: zId, qty: zQty, lots: zLots })).max(300),
  });
  type OrderUpdate = z.infer<typeof zOrderUpdate>;

  function updateOrder(id: number, input: OrderUpdate, userId: number | null) {
    const o = order(id);
    if (o.status !== 'draft') conflict('mfg.not_draft', 'Only a draft order can be changed');
    inventory().warehouse(input.warehouseId);
    inventory().warehouse(input.outputWarehouseId);
    const seen = new Set<number>();
    input.lines.forEach((l, i) => {
      const it = catalog().item(l.itemId);
      if (l.itemId === o.item_id) fail('mfg.self_component', `Line ${i + 1}: a product cannot be made from itself`, { line: i + 1 });
      if (!catalog().isStockItem(it)) fail('mfg.component_not_stock', `Line ${i + 1}: ${it.sku} is not kept in stock`, { line: i + 1, sku: it.sku });
      if (seen.has(l.itemId)) fail('mfg.duplicate_component', `Line ${i + 1}: ${it.sku} appears twice`, { line: i + 1, sku: it.sku });
      seen.add(l.itemId);
    });
    const std = JSON.parse(o.std) as Standard;
    const allow = allowed(std, input.outputQty);
    db.tx(() => {
      db.update('production_orders', id, {
        date: input.date,
        warehouse_id: input.warehouseId,
        output_warehouse_id: input.outputWarehouseId,
        output_qty: input.outputQty,
        labour_hours: input.labourHours,
        labour_cost: input.labourCost,
        notes: input.notes,
        output_lots: input.outputLots ? JSON.stringify(input.outputLots) : null,
        updated_at: nowIso(),
      });
      db.run('DELETE FROM production_order_lines WHERE order_id = ?', [id]);
      input.lines.forEach((l, i) =>
        db.insert('production_order_lines', {
          order_id: id,
          line_no: i + 1,
          item_id: l.itemId,
          std_qty: allow.components.find((c) => c.itemId === l.itemId)?.qty ?? 0,
          qty: l.qty,
          lots: l.lots ? JSON.stringify(l.lots) : null,
        }),
      );
      audit().log({ userId, action: 'update', entity: 'production_order', entityId: id, summary: o.number });
    });
  }

  function completeOrder(id: number, userId: number | null) {
    const o = order(id);
    if (o.status !== 'draft') conflict('mfg.not_draft', 'Only a draft order can be completed');
    const lines = orderLines(id);
    if (!lines.some((l) => l.qty > 0) && o.labour_hours === 0) fail('mfg.nothing_used', 'Enter the materials used or the labour hours');
    const std = JSON.parse(o.std) as Standard;
    const labourCost = o.labour_cost ?? Math.round((o.labour_hours * std.labourRate) / 1000);
    const overhead = Math.round((o.labour_hours * (std.varOverheadRate + std.fixedOverheadRate)) / 1000);
    db.tx(() => {
      const conversion = [
        { accountId: labourCost ? absorbedAccount('labour_account_id', userId) : 0, amount: labourCost },
        { accountId: overhead ? absorbedAccount('overhead_account_id', userId) : 0, amount: overhead },
      ].filter((c) => c.amount > 0);
      const item = catalog().item(o.item_id);
      const res = inventory().produce({
        date: o.date,
        sourceId: o.id,
        reference: o.number,
        memo: `${o.number} — ${item.sku} × ${o.output_qty / 1000}`,
        userId,
        components: lines.map((l) => ({ itemId: l.item_id, warehouseId: o.warehouse_id, qty: l.qty, lineId: l.id, lots: l.lots ? JSON.parse(l.lots) : null })),
        output: { itemId: o.item_id, warehouseId: o.output_warehouse_id, qty: o.output_qty, lots: o.output_lots ? JSON.parse(o.output_lots) : null },
        conversion,
      });
      lines.forEach((l, i) => db.run('UPDATE production_order_lines SET actual_cost = ? WHERE id = ?', [res.componentValues[i] ?? 0, l.id]));
      db.update('production_orders', id, {
        status: 'done',
        labour_cost: labourCost,
        materials_cost: res.materials,
        labour_applied: labourCost,
        overhead_applied: overhead,
        total_cost: res.outputValue,
        journal_entry_id: res.entryId,
        posted_at: nowIso(),
        updated_at: nowIso(),
      });
      audit().log({ userId, action: 'post', entity: 'production_order', entityId: id, summary: o.number });
    });
  }

  function voidOrder(id: number, date: string | null, userId: number | null) {
    const o = order(id);
    if (o.status !== 'done') conflict('mfg.not_done', 'Only a completed order can be reversed');
    const s = settings();
    db.tx(() => {
      const conversion = [
        { accountId: s.labour_account_id ?? 0, amount: o.labour_applied },
        { accountId: s.overhead_account_id ?? 0, amount: o.overhead_applied },
      ].filter((c) => c.amount > 0 && c.accountId);
      const entry = inventory().reverseProduction(o.id, date ?? o.date, conversion, `Void ${o.number}`, o.number, userId);
      db.update('production_orders', id, { status: 'void', void_entry_id: entry, voided_at: nowIso(), updated_at: nowIso() });
      audit().log({ userId, action: 'void', entity: 'production_order', entityId: id, summary: o.number });
    });
  }

  function orderView(id: number) {
    const o = order(id);
    const item = catalog().item(o.item_id);
    const lines = db.all<OrderLine & { sku: string; name_en: string; name_ar: string; tracking: string }>(
      `SELECT l.*, i.sku, i.name_en, i.name_ar, i.tracking FROM production_order_lines l JOIN items i ON i.id = l.item_id WHERE l.order_id = ? ORDER BY l.line_no`,
      [id],
    );
    const std = JSON.parse(o.std) as Standard;
    const cost = standardCost(std);
    const variances =
      o.status === 'done'
        ? orderVariances(std, o.output_qty, lines.map((l) => ({ itemId: l.item_id, qty: l.qty, cost: l.actual_cost })), o.labour_hours, o.labour_cost ?? 0)
        : null;
    const b = db.get<{ name: string }>('SELECT name FROM boms WHERE id = ?', [o.bom_id]);
    return {
      ...o,
      std: undefined,
      standard: std,
      standardCost: cost,
      bom_name: b?.name ?? null,
      sku: item.sku,
      name_en: item.name_en,
      name_ar: item.name_ar,
      tracking: item.tracking,
      output_lots: o.output_lots ? JSON.parse(o.output_lots) : null,
      lines: lines.map((l) => ({ ...l, lots: l.lots ? JSON.parse(l.lots) : null })),
      variances,
    };
  }

  // ---------------------------------------------------------------- period
  function periodReport(from: string, to: string) {
    const orders = db.all<Order & { sku: string; name_en: string; name_ar: string }>(
      `SELECT o.*, i.sku, i.name_en, i.name_ar FROM production_orders o JOIN items i ON i.id = o.item_id
       WHERE o.status = 'done' AND o.date BETWEEN ? AND ? ORDER BY o.date, o.id`,
      [from, to],
    );
    const rows = orders.map((o) => {
      const lines = orderLines(o.id);
      const v = orderVariances(JSON.parse(o.std) as Standard, o.output_qty, lines.map((l) => ({ itemId: l.item_id, qty: l.qty, cost: l.actual_cost })), o.labour_hours, o.labour_cost ?? 0);
      return { id: o.id, number: o.number, date: o.date, sku: o.sku, name_en: o.name_en, name_ar: o.name_ar, output_qty: o.output_qty, total_cost: o.total_cost, ...v.totals, labour: v.labour, overhead: v.overhead };
    });
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    const totals = {
      standard: sum((r) => r.standard),
      actual: sum((r) => r.actual),
      materialPrice: sum((r) => r.materialPrice),
      materialUsage: sum((r) => r.materialUsage),
      labourRate: sum((r) => r.labourRate),
      labourEfficiency: sum((r) => r.labourEfficiency),
      varOverheadEfficiency: sum((r) => r.varOverheadEfficiency),
      fixedOverheadEfficiency: sum((r) => r.fixedOverheadEfficiency),
      total: sum((r) => r.total),
    };
    const s = settings();
    const accounts = (JSON.parse(s.overhead_accounts) as number[]).filter((x) => Number.isInteger(x));
    const actual = accounts.length
      ? db.all<{ amount: number; variable_bp: number | null }>(
          `SELECT SUM(l.debit - l.credit) AS amount, a.variable_bp FROM ledger l JOIN accounts a ON a.id = l.account_id
           WHERE l.account_id IN (${accounts.map(() => '?').join(',')}) AND l.date BETWEEN ? AND ? AND l.source_type NOT IN ('closing', 'closing_reversal')
           GROUP BY l.account_id`,
          [...accounts, from, to],
        )
      : [];
    const actualVariable = Math.round(actual.reduce((a, x) => a + ((x.amount ?? 0) * (x.variable_bp ?? 0)) / 10000, 0));
    const actualTotal = actual.reduce((a, x) => a + (x.amount ?? 0), 0);
    // Only the months that have run so far carry a fixed-overhead budget (a report for "this year" in March).
    const budgetEnd = to < today() ? to : today();
    const months = budgetEnd >= from ? monthFraction(from, budgetEnd) : 0;
    const budgetedFixed = Math.round(s.budget_fixed_overhead * months);
    const oh = {
      actualHours: sum((r) => r.labour.actualHours),
      standardHours: sum((r) => r.labour.standardHours),
      appliedVariable: sum((r) => r.overhead.appliedVariable),
      appliedFixed: sum((r) => r.overhead.appliedFixed),
      standardVariable: sum((r) => r.overhead.standardVariable),
      standardFixed: sum((r) => r.overhead.standardFixed),
      actualVariable,
      actualFixed: actualTotal - actualVariable,
      budgetedFixed,
    };
    return { from, to, orders: rows, totals, overhead: { ...oh, tracked: accounts.length > 0, ...overheadVariances(oh) } };
  }

  return { bom, bomLines, bomView, writeBom, order, orderView, createOrder, updateOrder, completeOrder, voidOrder, periodReport, settings, zBom, zOrderUpdate };
}

export const manufacturingModule: AppModule = {
  id: 'manufacturing',
  dependsOn: ['ledger', 'catalog', 'inventory'],
  after: ['eco'],
  permissions: ['mfg.boms.read', 'mfg.boms.write', 'mfg.orders.read', 'mfg.orders.write', 'mfg.orders.post', 'mfg.reports.read', 'mfg.settings.manage'],
  apps: [{ id: 'mfg', order: 45, requires: ['inventory'], permissions: ['mfg'] }],
  roles: [{ id: 'production_planner', permissions: ['mfg.boms.*', 'mfg.orders.*', 'mfg.reports.read', 'inventory.stock.read'] }],
  migrations: [
    {
      id: '001_manufacturing',
      up: `
        -- Bill of materials ("recipe"): what one batch of a product uses, with its standard costs.
        CREATE TABLE boms (
          id                  INTEGER PRIMARY KEY,
          item_id             INTEGER NOT NULL REFERENCES items(id),
          name                TEXT NOT NULL,
          output_qty          INTEGER NOT NULL CHECK (output_qty > 0),      -- units per batch x1000
          labour_hours        INTEGER NOT NULL DEFAULT 0,                     -- per batch x1000
          labour_rate         INTEGER NOT NULL DEFAULT 0,                     -- per hour
          var_overhead_rate   INTEGER NOT NULL DEFAULT 0,                     -- per labour hour
          fixed_overhead_rate INTEGER NOT NULL DEFAULT 0,                     -- per labour hour
          is_active           INTEGER NOT NULL DEFAULT 1,
          notes               TEXT,
          created_by          INTEGER REFERENCES users(id),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX boms_item ON boms(item_id);
        CREATE TABLE bom_lines (
          id        INTEGER PRIMARY KEY,
          bom_id    INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
          line_no   INTEGER NOT NULL,
          item_id   INTEGER NOT NULL REFERENCES items(id),
          qty       INTEGER NOT NULL CHECK (qty > 0),                         -- per batch x1000
          scrap_bp  INTEGER NOT NULL DEFAULT 0,
          std_cost  INTEGER NOT NULL DEFAULT 0                                -- per unit
        );
        CREATE TABLE production_orders (
          id                  INTEGER PRIMARY KEY,
          number              TEXT NOT NULL UNIQUE,
          bom_id              INTEGER NOT NULL REFERENCES boms(id),
          item_id             INTEGER NOT NULL REFERENCES items(id),
          planned_qty         INTEGER NOT NULL,
          output_qty          INTEGER NOT NULL,
          date                TEXT NOT NULL,
          warehouse_id        INTEGER NOT NULL REFERENCES warehouses(id),
          output_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
          status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'done', 'void')),
          labour_hours        INTEGER NOT NULL DEFAULT 0,
          labour_cost         INTEGER,
          materials_cost      INTEGER NOT NULL DEFAULT 0,
          labour_applied      INTEGER NOT NULL DEFAULT 0,
          overhead_applied    INTEGER NOT NULL DEFAULT 0,
          total_cost          INTEGER NOT NULL DEFAULT 0,
          std                 TEXT NOT NULL,                                  -- the standard at release (JSON)
          output_lots         TEXT,
          journal_entry_id    INTEGER REFERENCES journal_entries(id),
          void_entry_id       INTEGER REFERENCES journal_entries(id),
          notes               TEXT,
          created_by          INTEGER REFERENCES users(id),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          posted_at           TEXT,
          voided_at           TEXT
        );
        CREATE INDEX production_orders_date ON production_orders(status, date);
        CREATE TABLE production_order_lines (
          id          INTEGER PRIMARY KEY,
          order_id    INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
          line_no     INTEGER NOT NULL,
          item_id     INTEGER NOT NULL REFERENCES items(id),
          std_qty     INTEGER NOT NULL DEFAULT 0,
          qty         INTEGER NOT NULL DEFAULT 0,
          actual_cost INTEGER NOT NULL DEFAULT 0,
          lots        TEXT
        );
        CREATE TRIGGER production_orders_no_delete BEFORE DELETE ON production_orders
        WHEN OLD.status <> 'draft'
        BEGIN SELECT RAISE(ABORT, 'manufacturing: completed orders cannot be deleted'); END;
        CREATE TABLE mfg_settings (
          id                    INTEGER PRIMARY KEY CHECK (id = 1),
          labour_account_id     INTEGER REFERENCES accounts(id),
          overhead_account_id   INTEGER REFERENCES accounts(id),
          budget_fixed_overhead INTEGER NOT NULL DEFAULT 0,                   -- per month
          overhead_accounts     TEXT NOT NULL DEFAULT '[]'                    -- expense accounts holding actual factory overhead
        );
        INSERT INTO mfg_settings (id) VALUES (1);
      `,
    },
    gmesWipMigration,
  ],

  setup(ctx) {
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('production_order', 'MO-', 1, 5)");
    consumeProduction(ctx);
  },

  health({ db }) {
    const bad = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM production_orders o WHERE o.status = 'done'
       AND o.total_cost <> o.materials_cost + o.labour_applied + o.overhead_applied`,
    )!.n;
    return [{ id: 'order_costs', ok: bad === 0, details: { count: bad } }];
  },

  routes(r, ctx) {
    const { db } = ctx;
    const mfg = createManufacturing(ctx);
    const audit = ctx.services.get('audit');

    // ------------------------------------------------------------ recipes
    // production recorded by manufacturing (GMES): what was issued to and received from work in progress, per work order
    r.get('/mfg/gmes-wip', 'mfg.reports.read', () => db.all('SELECT w.*, w.issued_value - w.received_value AS in_progress FROM mfg_wip w ORDER BY w.id DESC LIMIT 1000'));
    r.get('/mfg/boms', 'mfg.boms.read', () =>
      db
        .all<Bom & { sku: string; name_en: string; name_ar: string; lines: number }>(
          `SELECT b.*, i.sku, i.name_en, i.name_ar, (SELECT COUNT(*) FROM bom_lines l WHERE l.bom_id = b.id) AS lines
           FROM boms b JOIN items i ON i.id = b.item_id ORDER BY b.is_active DESC, i.sku, b.id`,
        )
        .map((b) => ({ ...b, unit_cost: standardCost({ outputQty: b.output_qty, labourHours: b.labour_hours, labourRate: b.labour_rate, varOverheadRate: b.var_overhead_rate, fixedOverheadRate: b.fixed_overhead_rate, components: mfg.bomLines(b.id).map((l) => ({ itemId: l.item_id, qty: l.qty, scrapBp: l.scrap_bp, stdCost: l.std_cost })) }).unit.total })),
    );
    r.get('/mfg/boms/:id', 'mfg.boms.read', ({ params }) => mfg.bomView(Number(params.id)));
    r.post('/mfg/boms', 'mfg.boms.write', ({ body, user }) => ({ id: mfg.writeBom(null, parse(mfg.zBom, body), user.id) }));
    r.put('/mfg/boms/:id', 'mfg.boms.write', ({ params, body, user }) => {
      mfg.bom(Number(params.id));
      return { id: mfg.writeBom(Number(params.id), parse(mfg.zBom, body), user.id) };
    });
    r.delete('/mfg/boms/:id', 'mfg.boms.write', ({ params, user }) => {
      const b = mfg.bom(Number(params.id));
      if (db.get('SELECT 1 FROM production_orders WHERE bom_id = ? LIMIT 1', [b.id])) conflict('mfg.bom_used', 'This recipe has orders — make it inactive instead');
      db.tx(() => {
        db.run('DELETE FROM boms WHERE id = ?', [b.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'bom', entityId: b.id, summary: b.name });
      });
      return { ok: true };
    });
    /** Set the standard cost of every component to its current average cost. */
    r.post('/mfg/boms/:id/update-standards', 'mfg.boms.write', ({ params, user }) => {
      const b = mfg.bom(Number(params.id));
      const inv = ctx.services.get('inventory');
      db.tx(() => {
        for (const l of mfg.bomLines(b.id)) db.run('UPDATE bom_lines SET std_cost = ? WHERE id = ?', [inv.unitCost(l.item_id), l.id]);
        audit.log({ userId: user.id, action: 'update', entity: 'bom', entityId: b.id, summary: 'standards' });
      });
      return { ok: true };
    });

    // ------------------------------------------------------------- orders
    r.get('/mfg/orders', 'mfg.orders.read', () =>
      db.all(
        `SELECT o.id, o.number, o.date, o.status, o.planned_qty, o.output_qty, o.total_cost, o.materials_cost, o.labour_applied, o.overhead_applied,
                i.sku, i.name_en, i.name_ar, b.name AS bom_name
         FROM production_orders o JOIN items i ON i.id = o.item_id JOIN boms b ON b.id = o.bom_id
         ORDER BY o.date DESC, o.id DESC`,
      ),
    );
    r.get('/mfg/orders/:id', 'mfg.orders.read', ({ params }) => mfg.orderView(Number(params.id)));
    r.post('/mfg/orders', 'mfg.orders.write', ({ body, user }) => {
      const q = parse(
        z.object({ bomId: zId, plannedQty: z.number().int().positive().max(1e12), date: zDate.default(today()), warehouseId: zId, outputWarehouseId: zOptId.transform((v) => v ?? null), notes: zOptText(1000) }),
        body,
      );
      return { id: mfg.createOrder(q, user.id) };
    });
    r.put('/mfg/orders/:id', 'mfg.orders.write', ({ params, body, user }) => {
      mfg.updateOrder(Number(params.id), parse(mfg.zOrderUpdate, body), user.id);
      return { ok: true };
    });
    r.post('/mfg/orders/:id/complete', 'mfg.orders.post', ({ params, user }) => {
      mfg.completeOrder(Number(params.id), user.id);
      return mfg.orderView(Number(params.id));
    });
    r.post('/mfg/orders/:id/void', 'mfg.orders.post', ({ params, body, user }) => {
      const q = parse(z.object({ date: zDate.nullish().transform((v) => v ?? null) }), body ?? {});
      mfg.voidOrder(Number(params.id), q.date, user.id);
      return { ok: true };
    });
    r.delete('/mfg/orders/:id', 'mfg.orders.write', ({ params, user }) => {
      const o = mfg.order(Number(params.id));
      if (o.status !== 'draft') conflict('mfg.not_draft', 'Only a draft order can be deleted');
      db.tx(() => {
        db.run('DELETE FROM production_orders WHERE id = ?', [o.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'production_order', entityId: o.id, summary: o.number });
      });
      return { ok: true };
    });

    // ------------------------------------------------------ report, setup
    r.get('/mfg/variances', 'mfg.reports.read', ({ query }) => {
      const y = today().slice(0, 4);
      const q = parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(today()) }), query);
      if (q.from > q.to) fail('validation', 'The start date must come before the end date');
      return mfg.periodReport(q.from, q.to);
    });
    r.get('/mfg/settings', 'mfg.orders.read', () => {
      const s = mfg.settings();
      return { ...s, overhead_accounts: JSON.parse(s.overhead_accounts) as number[] };
    });
    r.put('/mfg/settings', 'mfg.settings.manage', ({ body, user }) => {
      const q = parse(z.object({ budgetFixedOverhead: zQty, overheadAccounts: z.array(zId).max(100) }), body);
      const ledger = ctx.services.get('ledger');
      for (const id of q.overheadAccounts) {
        const a = ledger.account(id);
        if (a.type !== 'expense' || a.is_group) fail('mfg.overhead_account', `${a.code} is not an expense account`, { code: a.code });
      }
      const s = mfg.settings();
      if (q.overheadAccounts.some((id) => id === s.labour_account_id || id === s.overhead_account_id)) fail('mfg.overhead_account', 'The absorbed accounts cannot be counted as actual overhead', { code: '' });
      db.tx(() => {
        db.run('UPDATE mfg_settings SET budget_fixed_overhead = ?, overhead_accounts = ? WHERE id = 1', [q.budgetFixedOverhead, JSON.stringify([...new Set(q.overheadAccounts)])]);
        audit.log({ userId: user.id, action: 'update', entity: 'mfg_settings', entityId: 1, summary: 'settings' });
      });
      return { ok: true };
    });
  },
};
