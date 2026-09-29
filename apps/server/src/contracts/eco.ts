import type { Envelope, mizanId } from '../eco-contracts/index.js';

/**
 * The ecosystem integration socket (provided by the `eco` module, optional in every edition).
 *
 * Mizan is the OWNER of items, warehouses, parties, stock balances, purchase orders (and, with the sales
 * module, sales orders and the demand plan). Owners publish full snapshots of what they own; the eco
 * module writes them to the outbox in the same transaction as the change, versions them and serves the
 * feed. Manufacturing's conclusions (requisitions, supply plan …) arrive through the inbox and are handed
 * to the module that registered a consumer for their type.
 *
 * A module plugs in from its own setup, with `after: ['eco']` so the socket exists already:
 *
 *   if (ctx.services.has('eco')) ctx.services.get('eco').registerSnapshot({ type: 'acc.sales_order.v1', … });
 */

/** Entity names Mizan mints global ids for: UUIDv5(company id, "mizan:<entity>:<local id>"). */
export type EcoEntity = Parameters<typeof mizanId>[1];

export interface EcoBuildHelpers {
  companyId: string;
  /** Global id of a Mizan entity. */
  id(entity: EcoEntity, localId: number | string): string;
  /** `{ id, code }` reference to a Mizan entity. */
  ref(entity: EcoEntity, localId: number | string, code: string): { id: string; code: string };
  /** `{ app: 'mizan', type, key }`. */
  origin(entity: EcoEntity, localId: number | string): { app: string; type: string; key: string };
  /** Now, RFC 3339 (for `as_of`). */
  now: string;
}

/** One kind of snapshot an owner publishes. */
export interface EcoSnapshotSource {
  /** Contract type, e.g. `acc.sales_order.v1` (must be a type the vendored contracts know). */
  type: string;
  /** Entity of the global id and of the subject (`<entity>/<global id>`). */
  entity: EcoEntity;
  /**
   * The full snapshot WITHOUT `version` (the eco module adds it), or null when this entity is not
   * published (does not exist, still a draft …). Called inside the transaction of the change.
   */
  build(localId: string, h: EcoBuildHelpers): Record<string, unknown> | null;
  /** Every local id that may be published (full re-publication, reverse id lookup). */
  all(): string[];
  /** Top-level fields that change on every build and must not count as a change (e.g. `as_of`). */
  volatile?: string[];
}

/** What a consumer made of an event. Throw an AppError to reject it (its code is reported). */
export type EcoApplyResult = 'applied' | 'unchanged' | 'stale';

export interface EcoConsumer<T = unknown> {
  /** Event type, e.g. `mes.shipment.dispatched.v1`. */
  type: string;
  /** Runs inside a transaction together with the inbox record. */
  apply(data: T, envelope: Envelope<T>): EcoApplyResult;
}

/** One line of the latest supply plan received from manufacturing (quantities x1000). */
export interface EcoSupplyPlanLine {
  item_id: number | null;
  item_global_id: string;
  item_code: string;
  period: string;
  demand_qty: number;
  planned_qty: number;
  constraint: 'none' | 'capacity' | 'material' | 'both';
}

export interface EcoService {
  /** The company id (UUIDv7, set once). */
  companyId(): string;
  /** `eco://<company>/mizan/<node>`. */
  source(): string;
  globalId(entity: EcoEntity, localId: number | string): string;
  /** Local id of a Mizan entity from its global id (null when unknown). */
  localId(entity: EcoEntity, globalId: string): string | null;
  registerSnapshot(source: EcoSnapshotSource): void;
  registerConsumer<T>(consumer: EcoConsumer<T>): void;
  /**
   * Quantity reserved for an item in a warehouse (x1000), published as `reserved` in acc.stock_position.v1.
   * Several providers add up; without any the reserved quantity is 0. A provider must call
   * `changed('acc.stock_position.v1', \`${itemId}:${warehouseId}\`)` when its reservations move.
   */
  registerReservations(fn: (itemId: number, warehouseId: number) => number): void;
  /** Sum of the registered reservations for an item in a warehouse (x1000). */
  reservedQty(itemId: number, warehouseId: number): number;
  /** The entity changed: its snapshot is rebuilt and, when different, published before the transaction commits. */
  changed(type: string, localId: number | string): void;
  /** Publish a fact (not a snapshot) in the current transaction. */
  publish(e: { type: string; subject: string; correlation: string; causation?: string; data: unknown }): { id: string; seq: number };
  /** The latest supply plan from manufacturing. */
  supplyPlan(): EcoSupplyPlanLine[];
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    eco: EcoService;
  }
}
