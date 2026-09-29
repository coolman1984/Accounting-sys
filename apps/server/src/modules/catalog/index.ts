import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { parse, zOptId, zOptText } from '../../kernel/validate.js';
import { MATERIAL_TYPES, type CatalogService, type Item, type ItemUnit } from '../../contracts/catalog.js';
import { formatQty } from '../../eco-contracts/index.js';
import type {} from '../../contracts/eco.js';
import type {} from '../../contracts/parties.js';

export type { Item, ItemUnit } from '../../contracts/catalog.js';

const zItem = z.object({
  sku: z.string().trim().min(1).max(50),
  nameEn: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().min(1).max(200),
  kind: z.enum(['service', 'product']).default('service'),
  unit: zOptText(20),
  salePrice: z.number().int().min(0).default(0),
  purchasePrice: z.number().int().min(0).default(0),
  incomeAccountId: zOptId.transform((v) => v ?? null),
  expenseAccountId: zOptId.transform((v) => v ?? null),
  salesTaxId: zOptId.transform((v) => v ?? null),
  purchaseTaxId: zOptId.transform((v) => v ?? null),
  description: zOptText(1000),
  isActive: z.boolean().default(true),
  barcode: zOptText(64),
  categoryId: zOptId.transform((v) => v ?? null),
  trackStock: z.boolean().default(true),
  inventoryAccountId: zOptId.transform((v) => v ?? null),
  cogsAccountId: zOptId.transform((v) => v ?? null),
  reorderLevel: z.number().int().min(0).default(0),
  reorderQty: z.number().int().min(0).default(0),
  tracking: z.enum(['none', 'batch', 'serial']).default('none'),
  requiresExpiry: z.boolean().default(false),
  minSalePrice: z.number().int().min(0).default(0),
  // Planning (MRP) — all optional so older clients and imports keep working.
  materialType: z.enum(MATERIAL_TYPES).nullish().transform((v) => v ?? null),
  procurementType: z.enum(['buy', 'make']).default('buy'),
  leadTimeDays: z.number().int().min(0).max(3650).default(0),
  moq: z.number().int().min(0).default(0),
  lotSizeRule: z.enum(['lot_for_lot', 'fixed', 'multiple']).default('lot_for_lot'),
  lotSize: z.number().int().min(0).default(0),
  safetyStock: z.number().int().min(0).default(0),
  defaultSupplierId: zOptId.transform((v) => v ?? null),
  units: z
    .array(
      z.object({
        id: zOptId,
        nameEn: z.string().trim().min(1).max(40),
        nameAr: z.string().trim().min(1).max(40),
        factor: z.number().int().positive().max(1_000_000_000),
        barcode: zOptText(64),
        salePrice: z.number().int().min(0).nullish().transform((v) => v ?? null),
        purchasePrice: z.number().int().min(0).nullish().transform((v) => v ?? null),
        isActive: z.boolean().default(true),
      }),
    )
    .max(20)
    .default([]),
});

const zCategory = z.object({
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
});

/** Validation and writes for items, shared by the routes and the catalog service (imports). */
function createItemWriter({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');
    const postable = (id: number | null, label: string) => {
      if (id == null) return;
      const a = ledger().account(id);
      if (a.is_group) fail('account.group_not_allowed', `${label}: choose a posting account, not a group`);
    };
    const itemRow = (i: z.infer<typeof zItem>) => ({
      sku: i.sku,
      name_en: i.nameEn,
      name_ar: i.nameAr,
      kind: i.kind,
      unit: i.unit,
      sale_price: i.salePrice,
      purchase_price: i.purchasePrice,
      income_account_id: i.incomeAccountId,
      expense_account_id: i.expenseAccountId,
      sales_tax_id: i.salesTaxId,
      purchase_tax_id: i.purchaseTaxId,
      description: i.description,
      is_active: i.isActive,
      barcode: i.barcode,
      category_id: i.categoryId,
      track_stock: i.trackStock,
      inventory_account_id: i.inventoryAccountId,
      cogs_account_id: i.cogsAccountId,
      reorder_level: i.reorderLevel,
      reorder_qty: i.reorderQty,
      tracking: i.kind === 'product' && i.trackStock ? i.tracking : 'none',
      requires_expiry: i.kind === 'product' && i.trackStock && i.tracking === 'batch' && i.requiresExpiry,
      min_sale_price: i.minSalePrice,
      material_type: i.materialType,
      procurement_type: i.procurementType,
      lead_time_days: i.leadTimeDays,
      moq: i.moq,
      lot_size_rule: i.lotSizeRule,
      lot_size: i.lotSizeRule === 'lot_for_lot' ? 0 : i.lotSize,
      safety_stock: i.safetyStock,
      default_supplier_id: i.defaultSupplierId,
    });

    /** Upsert the item's units; units removed from the list are deactivated, never deleted (documents reference them). */
    const writeUnits = (itemId: number, units: z.infer<typeof zItem>['units']) => {
      const existing = db.all<ItemUnit>('SELECT * FROM item_units WHERE item_id = ?', [itemId]);
      const keep = new Set<number>();
      for (const u of units) {
        const row = {
          name_en: u.nameEn,
          name_ar: u.nameAr,
          factor: u.factor,
          barcode: u.barcode,
          sale_price: u.salePrice,
          purchase_price: u.purchasePrice,
          is_active: u.isActive,
        };
        const cur = u.id ? existing.find((e) => e.id === u.id) : undefined;
        if (u.id && !cur) notFound('item_unit', u.id);
        if (cur) {
          if (cur.factor !== u.factor && unitUsed(cur.id)) fail('item.unit_locked', `Unit ${cur.name_en} is used on documents; its size cannot change`);
          db.update('item_units', cur.id, row);
          keep.add(cur.id);
        } else keep.add(db.insert('item_units', { ...row, item_id: itemId, created_at: nowIso() }));
      }
      for (const e of existing) if (!keep.has(e.id)) db.run('UPDATE item_units SET is_active = 0 WHERE id = ?', [e.id]);
    };

    const unitUsed = (unitId: number) =>
      !!db.get('SELECT 1 FROM document_lines WHERE unit_id = ? LIMIT 1', [unitId]) ||
      (services.has('inventory') && services.get('inventory').unitUsed(unitId));

    const checkItem = (i: z.infer<typeof zItem>, current?: Item) => {
      postable(i.incomeAccountId, 'Income account');
      postable(i.expenseAccountId, 'Expense account');
      postable(i.cogsAccountId, 'Cost of sales account');
      if (i.inventoryAccountId && ledger().account(i.inventoryAccountId).subtype !== 'inventory') {
        fail('item.inventory_account', 'The inventory account must be an Inventory account');
      }
      if (i.categoryId && !db.get('SELECT 1 FROM item_categories WHERE id = ?', [i.categoryId])) notFound('item_category', i.categoryId);
      // Barcodes are unique across items and their units, so a scan always finds exactly one thing.
      const codes = [i.barcode, ...i.units.map((u) => u.barcode)].filter((b): b is string => !!b);
      if (new Set(codes).size !== codes.length) conflict('item.duplicate_barcode', 'The same barcode is used twice');
      for (const code of codes) {
        const onItem = db.get<{ id: number }>('SELECT id FROM items WHERE barcode = ?', [code]);
        const onUnit = db.get<{ item_id: number }>('SELECT item_id FROM item_units WHERE barcode = ?', [code]);
        if ((onItem && onItem.id !== current?.id) || (onUnit && onUnit.item_id !== current?.id)) {
          conflict('item.duplicate_barcode', `Barcode ${code} is already used by another item`, { barcode: code });
        }
      }
      if (i.units.some((u) => u.factor === 1000)) fail('item.unit_factor', 'An extra unit cannot equal the base unit');
      if (i.tracking === 'serial' && i.units.length) fail('item.serial_units', 'Serial-numbered items are counted one by one (no extra units)');
      // Once stock has moved, an item cannot stop (or start) being a stock item: its history would no longer add up.
      if (current && services.has('inventory') && services.get('inventory').hasMoves(current.id)) {
        const wasStock = current.kind === 'product' && current.track_stock === 1;
        const isStock = i.kind === 'product' && i.trackStock;
        if (wasStock !== isStock) fail('item.stock_locked', 'This item has stock movements; its stock tracking cannot change');
        if (current.tracking !== (isStock ? i.tracking : 'none')) fail('item.stock_locked', 'This item has stock movements; its lot/serial tracking cannot change');
        if ((current.inventory_account_id ?? null) !== i.inventoryAccountId) {
          fail('item.stock_locked', 'This item has stock movements; its inventory account cannot change');
        }
      }
      if (i.lotSizeRule !== 'lot_for_lot' && i.lotSize <= 0) fail('item.lot_size', 'Enter the lot size for this lot-size rule');
      if (i.defaultSupplierId) {
        if (!services.has('parties')) fail('item.no_parties', 'Suppliers are not installed');
        const p = services.get('parties').get(i.defaultSupplierId);
        if (p.kind === 'customer') fail('party.not_supplier', `${p.name} is not a supplier`);
      }
      // Default taxes come from the Tax module; without it an item simply carries none.
      for (const taxId of [i.salesTaxId, i.purchaseTaxId]) {
        if (!taxId) continue;
        if (!services.has('tax')) fail('tax.unavailable', 'Taxes are not installed');
        services.get('tax').get(taxId);
      }
    };


  /** Create an item from API-shaped input (validated here). */
  function createItem(raw: unknown, userId: number | null): number {
    const input = parse(zItem, raw);
    checkItem(input);
    if (db.get('SELECT 1 FROM items WHERE sku = ?', [input.sku])) conflict('item.duplicate_sku', 'SKU already exists');
    return db.tx(() => {
      const id = db.insert('items', { ...itemRow(input), created_at: nowIso() });
      writeUnits(id, input.units);
      audit().log({ userId, action: 'create', entity: 'item', entityId: id, summary: input.sku });
      itemChanged(services, id);
      return id;
    });
  }
  return { itemRow, writeUnits, checkItem, createItem };
}

const ITEM_V1 = 'eco.item.v1';
const itemChanged = (services: ModuleContext['services'], id: number) => services.has('eco') && services.get('eco').changed(ITEM_V1, id);

/** Base unit as a code on the wire ("pcs" → "PCS"); items without one count in "UNIT". */
export const uomCode = (unit: string | null | undefined) => (unit ?? '').trim().toUpperCase().slice(0, 64) || 'UNIT';

/** Mizan owns items: publish each one's snapshot (eco.item.v1) when the integration module is installed. */
function publishItems({ db, services }: ModuleContext) {
  if (!services.has('eco')) return;
  services.get('eco').registerSnapshot({
    type: ITEM_V1,
    entity: 'item',
    all: () => db.all<{ id: number }>('SELECT id FROM items ORDER BY id').map((r) => String(r.id)),
    build(localId, h) {
      const i = db.get<Item>('SELECT * FROM items WHERE id = ?', [Number(localId)]);
      if (!i) return null;
      const units = db.all<ItemUnit>('SELECT * FROM item_units WHERE item_id = ? AND is_active = 1 ORDER BY factor, id', [i.id]);
      return {
        id: h.id('item', i.id),
        code: i.sku,
        name: { en: i.name_en, ar: i.name_ar },
        active: !!i.is_active,
        origin: h.origin('item', i.id),
        kind: i.kind,
        stock_tracked: i.kind === 'product' && !!i.track_stock,
        tracking: i.tracking === 'batch' ? 'lot' : i.tracking,
        base_uom: uomCode(i.unit),
        units: units.map((u) => ({ code: uomCode(u.name_en), factor: formatQty(u.factor) })),
      };
    },
  });
}

function createCatalog(ctx: ModuleContext): CatalogService {
  const { db } = ctx;
  const writer = createItemWriter(ctx);
  return {
    item: (id) => db.get<Item>('SELECT * FROM items WHERE id = ?', [id]) ?? notFound('item', id),
    isStockItem: (item) => item.kind === 'product' && item.track_stock === 1,
    unit: (id) => db.get<ItemUnit>('SELECT * FROM item_units WHERE id = ?', [id]) ?? notFound('item_unit', id),
    units: (itemId) => db.all<ItemUnit>('SELECT * FROM item_units WHERE item_id = ? ORDER BY factor', [itemId]),
    unitFactor(item, unitId) {
      if (!unitId) return 1000;
      const u = db.get<ItemUnit>('SELECT * FROM item_units WHERE id = ?', [unitId]);
      if (!u || u.item_id !== item.id) return fail('item.unit_mismatch', `This unit does not belong to ${item.sku}`, { sku: item.sku });
      if (!u.is_active) fail('item.unit_inactive', `Unit ${u.name_en} of ${item.sku} is inactive`, { sku: item.sku });
      return u.factor;
    },
    createItem: writer.createItem,
  };
}

export const catalogModule: AppModule = {
  id: 'catalog',
  dependsOn: ['ledger'],
  permissions: ['catalog.items.read', 'catalog.items.write'],
  migrations: [
    {
      id: '001_catalog',
      up: `
        CREATE TABLE taxes (
          id                  INTEGER PRIMARY KEY,
          code                TEXT NOT NULL UNIQUE,
          name_en             TEXT NOT NULL,
          name_ar             TEXT NOT NULL,
          rate_bp             INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),  -- 1400 = 14%
          scope               TEXT NOT NULL DEFAULT 'both' CHECK (scope IN ('sales', 'purchases', 'both')),
          sales_account_id    INTEGER REFERENCES accounts(id),   -- output tax (liability)
          purchase_account_id INTEGER REFERENCES accounts(id),   -- input tax (asset)
          is_active           INTEGER NOT NULL DEFAULT 1,
          created_at          TEXT NOT NULL
        );

        CREATE TABLE items (
          id                 INTEGER PRIMARY KEY,
          sku                TEXT NOT NULL UNIQUE,
          name_en            TEXT NOT NULL,
          name_ar            TEXT NOT NULL,
          kind               TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'product')),
          unit               TEXT,
          sale_price         INTEGER NOT NULL DEFAULT 0,        -- minor units
          purchase_price     INTEGER NOT NULL DEFAULT 0,
          income_account_id  INTEGER REFERENCES accounts(id),
          expense_account_id INTEGER REFERENCES accounts(id),
          sales_tax_id       INTEGER REFERENCES taxes(id),
          purchase_tax_id    INTEGER REFERENCES taxes(id),
          description        TEXT,
          is_active          INTEGER NOT NULL DEFAULT 1,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX items_name ON items(name_en);
      `,
    },
    {
      id: '002_item_master',
      up: `
        CREATE TABLE item_categories (
          id         INTEGER PRIMARY KEY,
          name_en    TEXT NOT NULL,
          name_ar    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        ALTER TABLE items ADD COLUMN barcode TEXT;
        ALTER TABLE items ADD COLUMN category_id INTEGER REFERENCES item_categories(id);
        ALTER TABLE items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE items ADD COLUMN inventory_account_id INTEGER REFERENCES accounts(id);
        ALTER TABLE items ADD COLUMN cogs_account_id INTEGER REFERENCES accounts(id);
        ALTER TABLE items ADD COLUMN reorder_level INTEGER NOT NULL DEFAULT 0;   -- x1000
        ALTER TABLE items ADD COLUMN reorder_qty INTEGER NOT NULL DEFAULT 0;     -- x1000
        CREATE UNIQUE INDEX items_barcode ON items(barcode) WHERE barcode IS NOT NULL;
        CREATE INDEX items_category ON items(category_id);
      `,
    },
    {
      id: '003_units_tracking',
      up: `
        CREATE TABLE item_units (
          id             INTEGER PRIMARY KEY,
          item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name_en        TEXT NOT NULL,
          name_ar        TEXT NOT NULL,
          factor         INTEGER NOT NULL CHECK (factor > 0),   -- base units x1000 in one of this unit
          barcode        TEXT,
          sale_price     INTEGER,                                -- NULL = base price x factor
          purchase_price INTEGER,
          is_active      INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX item_units_item ON item_units(item_id);
        CREATE UNIQUE INDEX item_units_barcode ON item_units(barcode) WHERE barcode IS NOT NULL;
        ALTER TABLE items ADD COLUMN tracking TEXT NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'batch', 'serial'));
        ALTER TABLE items ADD COLUMN requires_expiry INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE items ADD COLUMN min_sale_price INTEGER NOT NULL DEFAULT 0;   -- per base unit
      `,
    },
    {
      // Planning fields for MRP and purchasing (lead time, MOQ, lot sizing, safety stock, usual supplier).
      id: '004_planning',
      up: `
        ALTER TABLE items ADD COLUMN material_type TEXT CHECK (material_type IS NULL OR material_type IN ('raw', 'semi_finished', 'finished', 'packaging', 'service'));
        ALTER TABLE items ADD COLUMN procurement_type TEXT NOT NULL DEFAULT 'buy' CHECK (procurement_type IN ('buy', 'make'));
        ALTER TABLE items ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0);
        ALTER TABLE items ADD COLUMN moq INTEGER NOT NULL DEFAULT 0 CHECK (moq >= 0);                     -- x1000
        ALTER TABLE items ADD COLUMN lot_size_rule TEXT NOT NULL DEFAULT 'lot_for_lot' CHECK (lot_size_rule IN ('lot_for_lot', 'fixed', 'multiple'));
        ALTER TABLE items ADD COLUMN lot_size INTEGER NOT NULL DEFAULT 0 CHECK (lot_size >= 0);           -- x1000
        ALTER TABLE items ADD COLUMN safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0);   -- x1000
        ALTER TABLE items ADD COLUMN default_supplier_id INTEGER;                                         -- parties(id), checked by the service
        CREATE INDEX items_default_supplier ON items(default_supplier_id) WHERE default_supplier_id IS NOT NULL;
      `,
    },
  ],
  after: ['eco'],

  setup(ctx) {
    ctx.services.provide('catalog', createCatalog(ctx));
    publishItems(ctx);
  },

  routes(r, ctx) {
    const { db, services } = ctx;
    const audit = services.get('audit');
    const { itemRow, writeUnits, checkItem } = createItemWriter(ctx);


    // -------------------------------------------------------------- items
    r.get('/items', 'catalog.items.read', ({ query }) => {
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.active === '1') where.push('i.is_active = 1');
      if (query.categoryId) (where.push('i.category_id = :cat'), (p.cat = Number(query.categoryId)));
      if (query.stock === '1') where.push("i.kind = 'product' AND i.track_stock = 1");
      if (query.q) {
        where.push('(i.sku LIKE :q OR i.name_en LIKE :q OR i.name_ar LIKE :q OR i.barcode = :exact OR i.id IN (SELECT item_id FROM item_units WHERE barcode = :exact))');
        p.q = `%${query.q}%`;
        p.exact = query.q;
      }
      const rows = db.all<Item>(
        `SELECT i.*, c.name_en AS category_name_en, c.name_ar AS category_name_ar
         FROM items i LEFT JOIN item_categories c ON c.id = i.category_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.sku LIMIT 20000`,
        p,
      );
      const units = new Map<number, ItemUnit[]>();
      for (const u of db.all<ItemUnit>('SELECT * FROM item_units ORDER BY factor')) units.set(u.item_id, [...(units.get(u.item_id) ?? []), u]);
      return rows.map((i) => ({ ...i, units: units.get(i.id) ?? [] }));
    });

    /** Barcode scanner lookup: an item's own barcode or one of its units'. */
    r.get('/items/lookup', 'catalog.items.read', ({ query }) => {
      const code = String(query.barcode ?? '');
      const item = db.get<Item>('SELECT * FROM items WHERE barcode = ?', [code]);
      if (item) return { item, unit: null };
      const unit = db.get<ItemUnit>('SELECT * FROM item_units WHERE barcode = ? AND is_active = 1', [code]);
      if (unit) return { item: services.get('catalog').item(unit.item_id), unit };
      return notFound('barcode', code);
    });

    // ------------------------------------------------------------ categories
    r.get('/item-categories', 'catalog.items.read', () =>
      db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS items
         FROM item_categories c ORDER BY c.name_en`,
      ),
    );

    r.post('/item-categories', 'catalog.items.write', ({ body, user }) => {
      const input = parse(zCategory, body);
      return db.tx(() => {
        const id = db.insert('item_categories', { name_en: input.nameEn, name_ar: input.nameAr, created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'item_category', entityId: id, summary: input.nameEn });
        return { id };
      });
    });

    r.put('/item-categories/:id', 'catalog.items.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zCategory, body);
      if (!db.get('SELECT 1 FROM item_categories WHERE id = ?', [id])) notFound('item_category', id);
      db.tx(() => {
        db.update('item_categories', id, { name_en: input.nameEn, name_ar: input.nameAr });
        audit.log({ userId: user.id, action: 'update', entity: 'item_category', entityId: id, data: input });
      });
      return { ok: true };
    });

    r.delete('/item-categories/:id', 'catalog.items.write', ({ params, user }) => {
      const id = Number(params.id);
      if (db.get('SELECT 1 FROM items WHERE category_id = ?', [id])) conflict('category.in_use', 'Move the items to another category first');
      db.tx(() => {
        db.run('DELETE FROM item_categories WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'item_category', entityId: id });
      });
      return { ok: true };
    });

    r.post('/items', 'catalog.items.write', ({ body, user }) => ({ id: services.get('catalog').createItem(body, user.id) }));

    r.put('/items/:id', 'catalog.items.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').item(id);
      const input = parse(zItem, body);
      checkItem(input, cur);
      const dup = db.get<{ id: number }>('SELECT id FROM items WHERE sku = ?', [input.sku]);
      if (dup && dup.id !== id) conflict('item.duplicate_sku', 'SKU already exists');
      db.tx(() => {
        db.update('items', id, itemRow(input));
        writeUnits(id, input.units);
        audit.log({ userId: user.id, action: 'update', entity: 'item', entityId: id, data: { before: cur, after: input } });
        itemChanged(services, id);
      });
      return { ok: true };
    });

    r.delete('/items/:id', 'catalog.items.write', ({ params, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').item(id);
      db.tx(() => {
        try {
          db.run('DELETE FROM items WHERE id = ?', [id]);
        } catch {
          conflict('item.in_use', 'This item is used on documents — deactivate it instead');
        }
        audit.log({ userId: user.id, action: 'delete', entity: 'item', entityId: id, summary: cur.sku });
      });
      return { ok: true };
    });
  },
};
