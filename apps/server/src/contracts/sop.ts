/** Sales & operations planning — provided by the S&OP module (always behind services.has('sop')). */
export interface SopPlanRow {
  itemId: number;
  sku: string;
  /** Calendar month, YYYY-MM. */
  month: string;
  /** Consensus demand, base units × 1000. */
  qty: number;
  unitPrice: number;
  amount: number;
}

export interface SopApprovedPlan {
  cycleId: number;
  /** The cycle, e.g. "2026-10" ("S&OP 2026-10"). */
  period: string;
  versionId: number;
  versionNo: number;
  approvedAt: string | null;
  rows: SopPlanRow[];
}

export interface SopService {
  /** The approved demand plan of a cycle (default: the latest cycle that has one), or null. */
  approvedPlan(period?: string | null): SopApprovedPlan | null;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    sop: SopService;
  }
}

declare module '../kernel/events.js' {
  interface EventMap {
    'sop.plan.approved': { versionId: number; cycleId: number; userId: number | null };
  }
}
