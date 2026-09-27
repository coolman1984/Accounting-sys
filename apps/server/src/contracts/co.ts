/** Controlling — cost centers as a dimension on ledger lines (provided by the CO module). */
export interface CostCenter {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  parent_id: number | null;
  is_active: number;
}

export interface CostCentersService {
  /** Throws when the cost center does not exist or is inactive. */
  assertUsable(id: number): CostCenter;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    costCenters: CostCentersService;
  }
}
