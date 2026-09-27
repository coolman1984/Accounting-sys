import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, nowIso } from '../../kernel/dates.js';
import { computeLine, divRound, fxToBase, sum } from '../../kernel/money.js';
import { ON_DEMAND } from '../ledger/chart-template.js';
import type {} from '../../contracts/fx.js';
import type { JournalLineInput } from '../ledger/service.js';
import type { DocKindInfo, DocSide, DocSideInfo, Document, DocumentLine, DocumentsService as DocumentsContract } from '../../contracts/documents.js';
import type { Tax } from '../../contracts/tax.js';
import { KIND_INFO, type DocKind } from './schema.js';

export type { Document } from '../../contracts/documents.js';

export interface DocLineInput {
  itemId?: number | null;
  description?: string | null;
  /** x1000 */
  quantity: number;
  unitPrice: number;
  discountBp?: number;
  accountId?: number | null;
  taxId?: number | null;
  /** Overrides the document's warehouse for this line. */
  warehouseId?: number | null;
  /** Alternative unit of measure (null = the item's base unit); quantity and price are in this unit. */
  unitId?: number | null;
  /** Controlling dimension (CO module). */
  costCenterId?: number | null;
  /**
   * Extension data other modules attach to a line (lots/serials, links to goods
   * receipts or purchase orders). Stored as-is; the owning module validates it.
   */
  ext?: Record<string, unknown> | null;
}

export interface DocInput {
  kind: DocKind;
  partyId: number;
  date: string;
  dueDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  taxInclusive?: boolean;
  againstDocumentId?: number | null;
  /** Default warehouse for stock lines. */
  warehouseId?: number | null;
  /** Document currency (default: the company's) and its rate (default: the day's rate). */
  currency?: string | null;
  exchangeRate?: number | null;
  lines: DocLineInput[];
}

export interface ComputedLine {
  item_id: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_bp: number;
  account_id: number;
  tax_id: number | null;
  tax_rate_bp: number;
  warehouse_id: number | null;
  unit_id: number | null;
  unit_factor: number;
  /** Quantity in the item's base unit (x1000) — what stock moves use. */
  base_quantity: number;
  ext: string | null;
  cost_center_id: number | null;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
  base_net: number;
  base_tax: number;
}

export type DocumentsService = ReturnType<typeof createDocuments>;

export function createDocuments({ db, services, events, apps }: ModuleContext) {
  const inventoryOn = () => services.has('inventory') && apps.isEnabled('inventory');
  const ledger = () => services.get('ledger');
  const parties = () => services.get('parties');
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');
  // Without the Tax app lines carry no tax; without CO no cost center.
  const taxOn = () => services.has('tax') && apps.isEnabled('tax');
  const tax = (id: number): Tax => (taxOn() ? services.get('tax').get(id) : fail('tax.unavailable', 'Taxes are not in use'));

  // AR and AP plug in the document kinds they sell; an unregistered kind cannot be used.
  const kinds = new Map<DocKind, DocKindInfo>();
  const sides = new Map<DocSide, DocSideInfo>();

  function get(id: number): Document {
    return db.get<Document>('SELECT * FROM documents WHERE id = ?', [id]) ?? notFound('document', id);
  }

  const baseCurrency = () => services.get('settings').company().baseCurrency;
  const fxOn = () => services.has('fx') && apps.isEnabled('fx');

  /** Currency and rate of a document; credit notes take the currency and rate of the document they correct. */
  function currencyOf(input: DocInput): { currency: string; rate: number } {
    const currency = (input.currency ?? baseCurrency()).toUpperCase();
    const orig = input.againstDocumentId ? get(input.againstDocumentId) : null;
    if (orig && orig.currency !== currency) fail('fx.currency_mismatch', `A correction must be in ${orig.currency}, like ${orig.number}`, { currency: orig.currency });
    if (currency === baseCurrency()) return { currency, rate: 1_000_000 };
    if (!fxOn()) fail('fx.unavailable', 'Multi-currency is switched off');
    const fx = services.get('fx');
    fx.assertCurrency(currency);
    if (orig) return { currency, rate: orig.exchange_rate };
    const rate = input.exchangeRate ?? fx.rate(currency, input.date);
    if (!Number.isSafeInteger(rate) || rate <= 0) fail('fx.invalid_rate', 'Invalid exchange rate');
    return { currency, rate };
  }

  function computeLines(input: DocInput, fxRate = 1_000_000): ComputedLine[] {
    const side = KIND_INFO[input.kind].side;
    if (input.lines.length === 0) fail('document.no_lines', 'Add at least one line');
    return input.lines.map((l, i) => {
      const n = i + 1;
      const item = l.itemId ? catalog().item(l.itemId) : null;
      if (item && !item.is_active) fail('document.inactive_item', `Line ${n}: item ${item.sku} is inactive`, { line: n });
      const description = (l.description ?? '').trim() || (item ? item.name_en : '');
      if (!description) fail('document.line_description', `Line ${n}: description is required`, { line: n });
      if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) fail('document.line_quantity', `Line ${n}: quantity must be positive`, { line: n });
      if (!Number.isSafeInteger(l.unitPrice) || l.unitPrice < 0) fail('document.line_price', `Line ${n}: invalid price`, { line: n });

      const factor = item ? catalog().unitFactor(item, l.unitId) : l.unitId ? fail('document.unit_without_item', `Line ${n}: a unit needs an item`, { line: n }) : 1000;
      const baseQty = Number(divRound(BigInt(l.quantity) * BigInt(factor), 1000n));
      if (baseQty <= 0) fail('document.line_quantity', `Line ${n}: quantity is too small for this unit`, { line: n });
      const ext = l.ext && Object.keys(l.ext).length ? JSON.stringify(l.ext) : null;
      if (ext && ext.length > 200_000) fail('document.ext_too_large', `Line ${n}: too much detail`, { line: n });

      // Stock items are bought into the inventory asset, everything else into an expense.
      // When inventory is installed it may redirect a stock line (e.g. goods already received => GRNI).
      // Without the Inventory app a product is simply bought as an expense (periodic stock).
      const stock = item && inventoryOn() ? catalog().isStockItem(item) : false;
      const hooked = side === 'purchases' && stock ? services.get('inventory').purchaseLineAccount(item!, l.ext ?? null) : null;
      const accountId =
        l.accountId ??
        hooked ??
        (side === 'sales'
          ? item?.income_account_id ?? ledger().defaultAccount(item?.kind === 'service' ? 'services' : 'sales')
          : stock
            ? item!.inventory_account_id ?? ledger().defaultAccount('inventory')
            : item?.expense_account_id ?? ledger().defaultAccount('purchases'));
      const acc = ledger().account(accountId);
      if (acc.is_group || !acc.is_active) fail('document.line_account', `Line ${n}: ${acc.code} cannot be used`, { line: n });
      if (acc.subtype === 'receivable' || acc.subtype === 'payable') {
        fail('document.line_account', `Line ${n}: control accounts cannot be used on lines`, { line: n });
      }

      let rate = 0;
      const taxId = taxOn() ? l.taxId ?? null : null;
      if (taxId) {
        const t = tax(taxId);
        if (!t.is_active) fail('document.inactive_tax', `Line ${n}: tax ${t.code} is inactive`, { line: n });
        const okScope = t.scope === 'both' || t.scope === side;
        if (!okScope) fail('document.tax_scope', `Line ${n}: tax ${t.code} is not for ${side}`, { line: n });
        rate = t.rate_bp;
      }
      const costCenterId = l.costCenterId ?? null;
      if (costCenterId) {
        if (!services.has('costCenters') || !apps.isEnabled('co')) fail('co.unavailable', `Line ${n}: cost centers are not in use`, { line: n });
        services.get('costCenters').assertUsable(costCenterId);
      }
      const discountBp = l.discountBp ?? 0;
      const c = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBp, rateBp: rate }, !!input.taxInclusive);
      return {
        item_id: item?.id ?? null,
        description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        discount_bp: discountBp,
        account_id: accountId,
        tax_id: taxId,
        tax_rate_bp: rate,
        warehouse_id: l.warehouseId ?? null,
        unit_id: l.unitId ?? null,
        unit_factor: factor,
        base_quantity: baseQty,
        ext,
        cost_center_id: costCenterId,
        ...c,
        base_net: fxToBase(c.net, fxRate),
        base_tax: fxToBase(c.tax, fxRate),
      };
    });
  }

  function validateHeader(input: DocInput, selfId: number | null) {
    const info = KIND_INFO[input.kind];
    const party = parties().get(input.partyId);
    parties().assertKind(party, info.side === 'sales' ? 'customer' : 'supplier');
    const due = input.dueDate ?? addDays(input.date, party.payment_terms_days);
    if (due < input.date) fail('document.due_before_date', 'Due date cannot be before the document date');
    if (input.againstDocumentId) {
      if (input.kind !== 'sales_credit' && input.kind !== 'purchase_credit') {
        fail('document.against_invalid', 'Only credit/debit notes can reference another document');
      }
      const orig = get(input.againstDocumentId);
      const expected = input.kind === 'sales_credit' ? 'sales_invoice' : 'purchase_bill';
      if (orig.kind !== expected || orig.status !== 'posted' || orig.party_id !== input.partyId || orig.id === selfId) {
        fail('document.against_invalid', 'The original document must be a posted document of the same party');
      }
    }
    return { party, due };
  }

  function writeDoc(id: number | null, input: DocInput, userId: number | null): number {
    const { due } = validateHeader(input, id);
    const { currency, rate } = currencyOf(input);
    const lines = computeLines(input, rate);
    const totals = {
      subtotal: sum(lines.map((l) => l.net)),
      discount_total: sum(lines.map((l) => l.discount)),
      tax_total: sum(lines.map((l) => l.tax)),
      total: sum(lines.map((l) => l.total)),
      // Base totals are sums of converted lines, so the journal balances to the cent.
      base_subtotal: sum(lines.map((l) => l.base_net)),
      base_tax_total: sum(lines.map((l) => l.base_tax)),
      base_total: sum(lines.map((l) => l.base_net + l.base_tax)),
      currency,
      exchange_rate: rate,
    };
    const header = {
      kind: input.kind,
      party_id: input.partyId,
      date: input.date,
      due_date: due,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      tax_inclusive: !!input.taxInclusive,
      against_document_id: input.againstDocumentId ?? null,
      warehouse_id: input.warehouseId ?? null,
      ...totals,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let docId = id;
      if (docId == null) {
        docId = db.insert('documents', {
          ...header,
          status: 'draft',
          created_by: userId,
          created_at: nowIso(),
        });
      } else {
        db.update('documents', docId, header);
        db.run('DELETE FROM document_lines WHERE document_id = ?', [docId]);
      }
      lines.forEach((l, i) => db.insert('document_lines', { document_id: docId, line_no: i + 1, ...l }));
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'document', entityId: docId, summary: input.kind });
      return docId;
    });
  }

  function create(input: DocInput, userId: number | null): number {
    return writeDoc(null, input, userId);
  }

  function update(id: number, input: DocInput, userId: number | null): void {
    const cur = get(id);
    if (cur.status !== 'draft') conflict('document.not_draft', 'Only drafts can be edited — void and re-issue instead');
    if (cur.kind !== input.kind) fail('document.kind_locked', 'The document type cannot change');
    writeDoc(id, input, userId);
  }

  function lines(id: number): DocumentLine[] {
    return db.all<DocumentLine>('SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no', [id]);
  }

  /** Build the balanced journal for a document. */
  function journalLines(doc: Document): JournalLineInput[] {
    const info = KIND_INFO[doc.kind];
    const party = parties().get(doc.party_id);
    const control = info.side === 'sales' ? parties().receivableAccount(party) : parties().payableAccount(party);
    // Invoices (and supplier debit notes) raise what the party owes us: control account debit,
    // revenue/tax credit. Bills and customer credit notes are the mirror image.
    const controlDebit = info.sign === 1;

    // One journal line per account and cost center.
    const byAccount = new Map<string, { acc: number; cc: number | null; amt: number }>();
    const add = (acc: number, cc: number | null, amt: number) => {
      const k = `${acc}:${cc ?? ''}`;
      const cur = byAccount.get(k) ?? { acc, cc, amt: 0 };
      cur.amt += amt;
      byAccount.set(k, cur);
    };
    for (const l of lines(doc.id)) {
      if (l.base_net !== 0) add(l.account_id, l.cost_center_id ?? null, l.base_net);
      if (l.base_tax !== 0) {
        // Posted with the tax it was drafted with, even if the Tax app was switched off since.
        const t = db.get<Tax>('SELECT * FROM taxes WHERE id = ?', [l.tax_id]) ?? notFound('tax', l.tax_id ?? 0);
        const taxAcc = info.side === 'sales' ? t.sales_account_id : t.purchase_account_id;
        if (!taxAcc) fail('tax.account_required', `Tax ${t.code} has no ${info.side === 'sales' ? 'output' : 'input'} account`);
        add(taxAcc!, null, l.base_tax);
      }
    }
    const out: JournalLineInput[] = [];
    // Control account line (the party balance).
    const foreign = doc.currency !== baseCurrency();
    out.push({
      accountId: control,
      partyId: party.id,
      debit: controlDebit ? doc.base_total : 0,
      credit: controlDebit ? 0 : doc.base_total,
      description: party.name,
      ...(foreign ? { currency: doc.currency, amountFx: controlDebit ? doc.total : -doc.total } : {}),
    });
    for (const { acc, cc, amt } of byAccount.values()) {
      if (amt === 0) continue;
      out.push({ accountId: acc, costCenterId: cc, debit: controlDebit ? 0 : amt, credit: controlDebit ? amt : 0 });
    }
    return out;
  }

  function post(id: number, userId: number | null): void {
    const doc = get(id);
    if (doc.status !== 'draft') conflict('document.not_draft', 'Document is already posted');
    if (doc.total <= 0) fail('document.zero_total', 'The document total must be greater than zero');
    if (doc.currency !== baseCurrency() && !fxOn()) fail('fx.unavailable', 'Multi-currency is switched off');
    const info = KIND_INFO[doc.kind];
    const party = parties().get(doc.party_id);
    parties().assertKind(party, info.side === 'sales' ? 'customer' : 'supplier');

    if (doc.kind === 'sales_invoice' && party.credit_limit != null) {
      const bal = db.get<{ b: number }>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE l.party_id = ? AND a.subtype = 'receivable'`,
        [party.id],
      )!.b;
      if (bal + doc.base_total > party.credit_limit) {
        fail('party.credit_limit', `${party.name} would exceed the credit limit`, { balance: bal, limit: party.credit_limit, total: doc.base_total });
      }
    }

    // A credit note settles the document it corrects. Both sides are valued in base currency;
    // any rounding cent between them is an exchange difference, booked in the same entry.
    const jl = journalLines(doc);
    let credit: { orig: Document; amount: number; origBase: number; ownBase: number } | null = null;
    if (doc.against_document_id) {
      const orig = get(doc.against_document_id);
      const amount = Math.min(doc.total, orig.total - orig.amount_settled);
      if (amount > 0) {
        const origBase = baseFor(orig, amount);
        const ownBase = baseFor(doc, amount);
        credit = { orig, amount, origBase, ownBase };
        const diff = ownBase - origBase;
        if (diff !== 0) {
          const control = jl[0].accountId;
          const sales = info.side === 'sales';
          // Sales: the receivable must rise by diff (gain when positive). Purchases: the payable must rise (loss when positive).
          const gain = sales ? diff : -diff;
          jl.push({ accountId: control, partyId: party.id, debit: sales && diff > 0 ? diff : !sales && diff < 0 ? -diff : 0, credit: sales && diff < 0 ? -diff : !sales && diff > 0 ? diff : 0, description: 'Exchange difference', currency: doc.currency, amountFx: 0 });
          jl.push(
            gain > 0
              ? { accountId: ledger().ensureDefaultAccount('fxGain', ON_DEMAND.fxGain), debit: 0, credit: gain }
              : { accountId: ledger().ensureDefaultAccount('fxLoss', ON_DEMAND.fxLoss), debit: -gain, credit: 0 },
          );
        }
      }
    }

    db.tx(() => {
      const number = services.get('sequences').next(info.seq);
      const entryId = ledger().createEntry(
        {
          date: doc.date,
          reference: number,
          memo: `${number} — ${party.name}`,
          lines: jl,
        },
        { sourceType: doc.kind, sourceId: doc.id, userId },
      );
      db.run(
        `UPDATE documents SET status = 'posted', number = ?, journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`,
        [number, entryId, nowIso(), nowIso(), id],
      );
      // A credit note raised against an invoice immediately settles it (as far as it's still open).
      if (credit) {
        settle(credit.orig.id, { sourceType: 'credit', sourceId: doc.id, sourceNumber: number, amount: credit.amount, date: doc.date, baseAmount: credit.origBase, sourceBaseAmount: credit.ownBase });
        db.run('UPDATE documents SET amount_settled = amount_settled + ?, base_settled = base_settled + ? WHERE id = ?', [credit.amount, credit.ownBase, doc.id]);
      }
      audit().log({ userId, action: 'post', entity: 'document', entityId: id, summary: number });
      events.emit('document.posted', { documentId: id, kind: doc.kind, userId });
    });
  }

  function voidDoc(id: number, opts: { date?: string | null }, userId: number | null): void {
    const doc = get(id);
    if (doc.status !== 'posted') conflict('document.not_posted', 'Only posted documents can be voided');
    const received = db.get<{ n: number }>('SELECT COUNT(*) n FROM settlements WHERE document_id = ?', [id])!.n;
    if (received > 0) {
      conflict('document.has_settlements', 'This document has payments or credit notes applied — void those first');
    }
    db.tx(() => {
      // Undo credits this note applied to other documents.
      unsettleSource('credit', id);
      db.run('UPDATE documents SET amount_settled = 0, base_settled = 0 WHERE id = ?', [id]);
      const revId = ledger().reverseEntry(doc.journal_entry_id!, { date: opts.date ?? doc.date, memo: `Void ${doc.number}` }, userId);
      db.run(`UPDATE documents SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [
        revId,
        nowIso(),
        nowIso(),
        id,
      ]);
      audit().log({ userId, action: 'void', entity: 'document', entityId: id, summary: doc.number });
      events.emit('document.voided', { documentId: id, kind: doc.kind, date: opts.date ?? doc.date, userId });
    });
  }

  function remove(id: number, userId: number | null): void {
    const doc = get(id);
    if (doc.status !== 'draft') conflict('document.not_draft', 'Only drafts can be deleted — void posted documents');
    db.tx(() => {
      db.run('DELETE FROM documents WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'document', entityId: id, summary: doc.kind });
    });
  }

  // ----------------------------------------------------------- settlements

  /** Base value of settling `amount`: at the document's rate, or exactly what is left when it clears the document. */
  function baseFor(doc: Document, amount: number): number {
    if (amount === doc.total - doc.amount_settled) return doc.base_total - doc.base_settled;
    return fxToBase(amount, doc.exchange_rate);
  }

  function settle(
    documentId: number,
    s: { sourceType: 'payment' | 'credit'; sourceId: number; sourceNumber: string | null; amount: number; date: string; baseAmount?: number; sourceBaseAmount?: number },
  ): void {
    const doc = get(documentId);
    if (doc.status !== 'posted') fail('settlement.not_posted', `${doc.number ?? 'Draft'} is not posted`);
    const outstanding = doc.total - doc.amount_settled;
    if (s.amount <= 0 || s.amount > outstanding) {
      fail('settlement.exceeds', `Amount exceeds what is outstanding on ${doc.number}`, { number: doc.number, outstanding });
    }
    const base = s.baseAmount ?? baseFor(doc, s.amount);
    db.tx(() => {
      db.insert('settlements', {
        document_id: documentId,
        source_type: s.sourceType,
        source_id: s.sourceId,
        source_number: s.sourceNumber,
        amount: s.amount,
        base_amount: base,
        source_base_amount: s.sourceBaseAmount ?? base,
        date: s.date,
        created_at: nowIso(),
      });
      db.run('UPDATE documents SET amount_settled = amount_settled + ?, base_settled = base_settled + ?, updated_at = ? WHERE id = ?', [s.amount, base, nowIso(), documentId]);
    });
  }

  function unsettleSource(sourceType: 'payment' | 'credit', sourceId: number): void {
    db.tx(() => {
      const rows = db.all<{ id: number; document_id: number; amount: number; base_amount: number }>(
        'SELECT id, document_id, amount, base_amount FROM settlements WHERE source_type = ? AND source_id = ?',
        [sourceType, sourceId],
      );
      for (const r of rows) {
        db.run('UPDATE documents SET amount_settled = amount_settled - ?, base_settled = base_settled - ?, updated_at = ? WHERE id = ?', [r.amount, r.base_amount, nowIso(), r.document_id]);
        db.run('DELETE FROM settlements WHERE id = ?', [r.id]);
      }
    });
  }

  const contract: DocumentsContract = {
    get,
    lines,
    settle,
    baseFor,
    unsettleSource,
    registerKind: (kind, info) => void kinds.set(kind, info),
    registerSide: (side, info) => void sides.set(side, info),
    kind: (kind) => kinds.get(kind) ?? null,
  };
  return { ...contract, side: (side: DocSide) => sides.get(side) ?? null, create, update, post, void: voidDoc, remove, journalLines };
}
