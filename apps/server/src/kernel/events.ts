/**
 * Synchronous in-process event bus.
 *
 * Listeners run inside the emitter's database transaction, so a listener that
 * throws rolls back the whole operation. This is how modules react to each
 * other (e.g. "document posted") without importing each other.
 */
export interface EventMap {
  'journal.posted': { entryId: number };
  'journal.reversed': { entryId: number; reversalId: number };
  'document.posted': { documentId: number; kind: string; userId: number | null };
  'document.voided': { documentId: number; kind: string; date: string; userId: number | null };
  'payment.posted': { paymentId: number };
  'payment.voided': { paymentId: number };
  'fiscalYear.closed': { fiscalYearId: number };
  /** Goods receipt notes (inventory) — purchasing follows them to update purchase orders. */
  'stock.receipt.posted': { receiptId: number; userId: number | null };
  'stock.receipt.voided': { receiptId: number; userId: number | null };
  /** First-run setup; modules seed their defaults (chart of accounts, taxes …). */
  'system.setup': SetupPayload;
}

export interface SetupPayload {
  locale: 'en' | 'ar';
  fiscalYearStart: string;
  seedChartOfAccounts: boolean;
  /** Default VAT rate in basis points, null = no tax seeded. */
  vatRateBp: number | null;
}

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export class EventBus {
  private listeners = new Map<keyof EventMap, Listener<any>[]>();

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => {
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    };
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
}
