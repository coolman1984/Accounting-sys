/** The sales budget (quantity × price per item and month) — provided by the Budgets module (behind services.has('budgetSales')). */
export interface BudgetSalesRow {
  budgetId: number;
  budgetName: string;
  /** 'approved' budgets win over drafts for the same month. */
  status: 'draft' | 'approved';
  itemId: number;
  /** Calendar month, YYYY-MM. */
  month: string;
  /** Base units × 1000. */
  qty: number;
  /** Budget unit price (base currency, per base unit). */
  unitPrice: number;
  /** qty × unit price. */
  amount: number;
}

export interface BudgetSalesService {
  /** Budgeted sales for `months` calendar months from `fromMonth` (YYYY-MM): per month, the latest approved budget, else the latest draft. */
  salesPlan(fromMonth: string, months: number): BudgetSalesRow[];
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    budgetSales: BudgetSalesService;
  }
}
