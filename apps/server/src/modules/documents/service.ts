import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, nowIso } from '../../kernel/dates.js';
import { applyRate, lineAmount, netOfInclusive, sum } from '../../kernel/money.js';
import type { JournalLineInput } from '../ledger/service.js';
import { KIND_INFO, type DocKind } from './schema.js';

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
  lines: DocLineInput[];
}

export interface Document {
  id: number;
  kind: DocKind;
  number: string | null;
  party_id: number;
  date: string;
  due_date: string;
  reference: string | null;
  notes: string | null;
  currency: string;
  tax_inclusive: number;
  status: 'draft' | 'posted' | 'void';
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  amount_settled: number;
  against_document_id: number | null;
  journal_entry_id: number | null;
  void_entry_id: number | null;
  warehouse_id: number | null;
  created_at: string;
  posted_at: string | null;
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
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

/** Pure line math — also used by the web app preview (mirrored in TypeScript there). */
export function computeLine(l: { quantity: number; unitPrice: number; discountBp: number; rateBp: number }, inclusive: boolean) {
  const gross = lineAmount(l.quantity, l.unitPrice);
  const discount = applyRate(gross, l.discountBp);
  const after = gross - discount;
  const net = inclusive ? netOfInclusive(after, l.rateBp) : after;
  const tax = inclusive ? after - net : applyRate(net, l.rateBp);
  return { gross, discount, net, tax, total: net + tax };
}

export type DocumentsService = ReturnType<typeof createDocuments>;

export function createDocuments({ db, services, events }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const parties = () => services.get('parties');
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');

  function get(id: number): Document {
    return db.get<Document>('SELECT * FROM documents WHERE id = ?', [id]) ?? notFound('document', id);
  }

  function computeLines(input: DocInput): ComputedLine[] {
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

      // Stock items are bought into the inventory asset, everything else into an expense.
      const stock = item ? catalog().isStockItem(item) : false;
      const accountId =
        l.accountId ??
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
      const taxId = l.taxId ?? null;
      if (taxId) {
        const tax = catalog().tax(taxId);
        if (!tax.is_active) fail('document.inactive_tax', `Line ${n}: tax ${tax.code} is inactive`, { line: n });
        const okScope = tax.scope === 'both' || tax.scope === side;
        if (!okScope) fail('document.tax_scope', `Line ${n}: tax ${tax.code} is not for ${side}`, { line: n });
        rate = tax.rate_bp;
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
        ...c,
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
    const lines = computeLines(input);
    const totals = {
      subtotal: sum(lines.map((l) => l.net)),
      discount_total: sum(lines.map((l) => l.discount)),
      tax_total: sum(lines.map((l) => l.tax)),
      total: sum(lines.map((l) => l.total)),
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
          currency: services.get('settings').company().baseCurrency,
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

  function lines(id: number): (ComputedLine & { id: number; line_no: number })[] {
    return db.all('SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no', [id]);
  }

  /** Build the balanced journal for a document. */
  function journalLines(doc: Document): JournalLineInput[] {
    const info = KIND_INFO[doc.kind];
    const party = parties().get(doc.party_id);
    const control = info.side === 'sales' ? parties().receivableAccount(party) : parties().payableAccount(party);
    // Invoices (and supplier debit notes) raise what the party owes us: control account debit,
    // revenue/tax credit. Bills and customer credit notes are the mirror image.
    const controlDebit = info.sign === 1;

    const byAccount = new Map<number, number>();
    const add = (acc: number, amt: number) => byAccount.set(acc, (byAccount.get(acc) ?? 0) + amt);
    for (const l of lines(doc.id)) {
      if (l.net !== 0) add(l.account_id, l.net);
      if (l.tax !== 0) {
        const tax = catalog().tax(l.tax_id!);
        const taxAcc = info.side === 'sales' ? tax.sales_account_id : tax.purchase_account_id;
        if (!taxAcc) fail('tax.account_required', `Tax ${tax.code} has no ${info.side === 'sales' ? 'output' : 'input'} account`);
        add(taxAcc!, l.tax);
      }
    }
    const out: JournalLineInput[] = [];
    // Control account line (the party balance).
    out.push({
      accountId: control,
      partyId: party.id,
      debit: controlDebit ? doc.total : 0,
      credit: controlDebit ? 0 : doc.total,
      description: party.name,
    });
    for (const [acc, amt] of byAccount) {
      if (amt === 0) continue;
      out.push({ accountId: acc, debit: controlDebit ? 0 : amt, credit: controlDebit ? amt : 0 });
    }
    return out;
  }

  function post(id: number, userId: number | null): void {
    const doc = get(id);
    if (doc.status !== 'draft') conflict('document.not_draft', 'Document is already posted');
    if (doc.total <= 0) fail('document.zero_total', 'The document total must be greater than zero');
    const info = KIND_INFO[doc.kind];
    const party = parties().get(doc.party_id);
    parties().assertKind(party, info.side === 'sales' ? 'customer' : 'supplier');

    if (doc.kind === 'sales_invoice' && party.credit_limit != null) {
      const bal = db.get<{ b: number }>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE l.party_id = ? AND a.subtype = 'receivable'`,
        [party.id],
      )!.b;
      if (bal + doc.total > party.credit_limit) {
        fail('party.credit_limit', `${party.name} would exceed the credit limit`, { balance: bal, limit: party.credit_limit, total: doc.total });
      }
    }

    db.tx(() => {
      const number = services.get('sequences').next(info.seq);
      const entryId = ledger().createEntry(
        {
          date: doc.date,
          reference: number,
          memo: `${number} — ${party.name}`,
          lines: journalLines(doc),
        },
        { sourceType: doc.kind, sourceId: doc.id, userId },
      );
      db.run(
        `UPDATE documents SET status = 'posted', number = ?, journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`,
        [number, entryId, nowIso(), nowIso(), id],
      );
      // A credit note raised against an invoice immediately settles it (as far as it's still open).
      if (doc.against_document_id) {
        const orig = get(doc.against_document_id);
        const amount = Math.min(doc.total, orig.total - orig.amount_settled);
        if (amount > 0) {
          settle(orig.id, { sourceType: 'credit', sourceId: doc.id, sourceNumber: number, amount, date: doc.date });
          db.run('UPDATE documents SET amount_settled = amount_settled + ? WHERE id = ?', [amount, doc.id]);
        }
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
      db.run('UPDATE documents SET amount_settled = 0 WHERE id = ?', [id]);
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

  function settle(
    documentId: number,
    s: { sourceType: 'payment' | 'credit'; sourceId: number; sourceNumber: string | null; amount: number; date: string },
  ): void {
    const doc = get(documentId);
    if (doc.status !== 'posted') fail('settlement.not_posted', `${doc.number ?? 'Draft'} is not posted`);
    const outstanding = doc.total - doc.amount_settled;
    if (s.amount <= 0 || s.amount > outstanding) {
      fail('settlement.exceeds', `Amount exceeds what is outstanding on ${doc.number}`, { number: doc.number, outstanding });
    }
    db.tx(() => {
      db.insert('settlements', {
        document_id: documentId,
        source_type: s.sourceType,
        source_id: s.sourceId,
        source_number: s.sourceNumber,
        amount: s.amount,
        date: s.date,
        created_at: nowIso(),
      });
      db.run('UPDATE documents SET amount_settled = amount_settled + ?, updated_at = ? WHERE id = ?', [s.amount, nowIso(), documentId]);
    });
  }

  function unsettleSource(sourceType: 'payment' | 'credit', sourceId: number): void {
    db.tx(() => {
      const rows = db.all<{ id: number; document_id: number; amount: number }>(
        'SELECT id, document_id, amount FROM settlements WHERE source_type = ? AND source_id = ?',
        [sourceType, sourceId],
      );
      for (const r of rows) {
        db.run('UPDATE documents SET amount_settled = amount_settled - ?, updated_at = ? WHERE id = ?', [r.amount, nowIso(), r.document_id]);
        db.run('DELETE FROM settlements WHERE id = ?', [r.id]);
      }
    });
  }

  return { get, lines, create, update, post, void: voidDoc, remove, settle, unsettleSource, journalLines };
}
