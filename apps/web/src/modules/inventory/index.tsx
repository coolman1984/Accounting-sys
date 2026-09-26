import { ArrowLeftRight, Boxes, ClipboardCheck, ClipboardList, Coins, PackageSearch, RefreshCcw, SlidersHorizontal, TrendingUp, Warehouse } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { StockPage } from './StockPage';
import { ItemCardPage } from './ItemCardPage';
import { WarehousesPage } from './WarehousesPage';
import { OperationsList } from './OperationsList';
import { OperationEditor } from './OperationEditor';
import { OperationView } from './OperationView';
import { MovementPage, ProfitabilityPage, ReorderPage, ValuationPage } from './reports';
import { DocumentStockPanel, InventoryWidget } from './panels';

export const inventoryModule: WebModule = {
  id: 'inventory',
  nav: [
    { to: '/inventory', label: 'nav.stock', icon: Boxes, section: 'inventory', order: 0, perm: 'inventory.read', end: true },
    { to: '/inventory/operations', label: 'nav.operations', icon: ClipboardList, section: 'inventory', order: 20, perm: 'inventory.read' },
    { to: '/inventory/warehouses', label: 'nav.warehouses', icon: Warehouse, section: 'inventory', order: 30, perm: 'inventory.read' },
  ],
  routes: [
    { path: '/inventory', element: <StockPage /> },
    { path: '/inventory/items/:id', element: <ItemCardPage /> },
    { path: '/inventory/warehouses', element: <WarehousesPage /> },
    { path: '/inventory/operations', element: <OperationsList /> },
    { path: '/inventory/operations/new', element: <OperationEditor key="new" /> },
    { path: '/inventory/operations/:id', element: <OperationView /> },
    { path: '/inventory/operations/:id/edit', element: <OperationEditor key="edit" /> },
    { path: '/reports/inventory/valuation', element: <ValuationPage /> },
    { path: '/reports/inventory/movement', element: <MovementPage /> },
    { path: '/reports/inventory/reorder', element: <ReorderPage /> },
    { path: '/reports/inventory/profitability', element: <ProfitabilityPage /> },
  ],
  commands: [
    { id: 'go-stock', label: 'nav.stock', icon: Boxes, group: 'navigate', to: '/inventory', perm: 'inventory.read', keywords: 'stock inventory مخزون مخازن رصيد' },
    { id: 'new-adjust', label: 'inventory.kinds.adjustment', icon: SlidersHorizontal, group: 'create', to: '/inventory/operations/new?kind=adjustment', perm: 'inventory.write', keywords: 'adjust تسوية' },
    { id: 'new-transfer', label: 'inventory.kinds.transfer', icon: ArrowLeftRight, group: 'create', to: '/inventory/operations/new?kind=transfer', perm: 'inventory.write', keywords: 'transfer move تحويل' },
    { id: 'new-count', label: 'inventory.kinds.count', icon: ClipboardCheck, group: 'create', to: '/inventory/operations/new?kind=count', perm: 'inventory.write', keywords: 'count stocktake جرد' },
    { id: 'go-warehouses', label: 'nav.warehouses', icon: Warehouse, group: 'navigate', to: '/inventory/warehouses', perm: 'inventory.read', keywords: 'warehouse مخزن' },
    { id: 'go-valuation', label: 'inventory.reports.valuation', icon: Coins, group: 'navigate', to: '/reports/inventory/valuation', perm: 'inventory.read', keywords: 'تقييم' },
  ],
  reports: [
    { to: '/reports/inventory/valuation', group: 'inventory.reports.group', title: 'inventory.reports.valuation', desc: 'inventory.reports.valuationDesc', icon: Coins, color: 'var(--line-amber)', perm: 'inventory.read' },
    { to: '/reports/inventory/movement', group: 'inventory.reports.group', title: 'inventory.reports.movement', desc: 'inventory.reports.movementDesc', icon: PackageSearch, color: 'var(--line-blue)', perm: 'inventory.read' },
    { to: '/reports/inventory/reorder', group: 'inventory.reports.group', title: 'inventory.reports.reorder', desc: 'inventory.reports.reorderDesc', icon: RefreshCcw, color: 'var(--line-pink)', perm: 'inventory.read' },
    { to: '/reports/inventory/profitability', group: 'inventory.reports.group', title: 'inventory.reports.profitability', desc: 'inventory.reports.profitabilityDesc', icon: TrendingUp, color: 'var(--line-teal)', perm: 'inventory.read' },
  ],
  slots: {
    'document.view': DocumentStockPanel,
    'dashboard.widgets': InventoryWidget,
  },
};
