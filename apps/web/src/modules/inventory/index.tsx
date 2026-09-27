import { ArrowLeftRight, Boxes, CalendarClock, PackageCheck, PackageOpen, ScanSearch, Ship, ClipboardCheck, ClipboardList, Coins, PackageSearch, RefreshCcw, SlidersHorizontal, TrendingUp, Warehouse } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { StockPage } from './StockPage';
import { ItemCardPage } from './ItemCardPage';
import { WarehousesPage } from './WarehousesPage';
import { OperationsList } from './OperationsList';
import { OperationEditor } from './OperationEditor';
import { OperationView } from './OperationView';
import { MovementPage, ProfitabilityPage, ReorderPage, ValuationPage } from './reports';
import { DocumentStockPanel, InventoryWidget } from './panels';
import { ReceiptEditor, ReceiptView, ReceiptsList } from './receipts';
import { LandedEditor, LandedList, LandedView } from './landed';
import { ExpiryPage, GrniPage, TracePage } from './advreports';

export const inventoryModule: WebModule = {
  id: 'inventory',
  nav: [
    { to: '/inventory', label: 'nav.stock', icon: Boxes, section: 'inventory', order: 0, perm: 'inventory.stock.read', app: 'inventory', end: true },
    { to: '/inventory/receipts', label: 'nav.goodsReceipts', icon: PackageCheck, section: 'purchases', order: 6, perm: 'inventory.receipts.read', app: 'inventory' },
    { to: '/inventory/landed-costs', label: 'nav.landedCosts', icon: Ship, section: 'inventory', order: 25, perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/inventory/operations', label: 'nav.operations', icon: ClipboardList, section: 'inventory', order: 20, perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/inventory/warehouses', label: 'nav.warehouses', icon: Warehouse, section: 'inventory', order: 30, perm: 'inventory.stock.read', app: 'inventory' },
  ],
  routes: [
    { path: '/inventory', element: <StockPage /> },
    { path: '/inventory/items/:id', element: <ItemCardPage /> },
    { path: '/inventory/warehouses', element: <WarehousesPage /> },
    { path: '/inventory/operations', element: <OperationsList /> },
    { path: '/inventory/operations/new', element: <OperationEditor key="new" /> },
    { path: '/inventory/operations/:id', element: <OperationView /> },
    { path: '/inventory/operations/:id/edit', element: <OperationEditor key="edit" /> },
    { path: '/inventory/receipts', element: <ReceiptsList /> },
    { path: '/inventory/receipts/new', element: <ReceiptEditor key="new" /> },
    { path: '/inventory/receipts/:id', element: <ReceiptView /> },
    { path: '/inventory/receipts/:id/edit', element: <ReceiptEditor key="edit" /> },
    { path: '/inventory/landed-costs', element: <LandedList /> },
    { path: '/inventory/landed-costs/new', element: <LandedEditor key="new" /> },
    { path: '/inventory/landed-costs/:id', element: <LandedView /> },
    { path: '/inventory/landed-costs/:id/edit', element: <LandedEditor key="edit" /> },
    { path: '/reports/inventory/expiry', element: <ExpiryPage /> },
    { path: '/reports/inventory/trace', element: <TracePage /> },
    { path: '/reports/inventory/grni', element: <GrniPage /> },
    { path: '/reports/inventory/valuation', element: <ValuationPage /> },
    { path: '/reports/inventory/movement', element: <MovementPage /> },
    { path: '/reports/inventory/reorder', element: <ReorderPage /> },
    { path: '/reports/inventory/profitability', element: <ProfitabilityPage /> },
  ],
  commands: [
    { id: 'go-stock', label: 'nav.stock', icon: Boxes, group: 'navigate', to: '/inventory', perm: 'inventory.stock.read', app: 'inventory', keywords: 'stock inventory مخزون مخازن رصيد' },
    { id: 'new-adjust', label: 'inventory.kinds.adjustment', icon: SlidersHorizontal, group: 'create', to: '/inventory/operations/new?kind=adjustment', perm: 'inventory.operations.write', app: 'inventory', keywords: 'adjust تسوية' },
    { id: 'new-transfer', label: 'inventory.kinds.transfer', icon: ArrowLeftRight, group: 'create', to: '/inventory/operations/new?kind=transfer', perm: 'inventory.operations.write', app: 'inventory', keywords: 'transfer move تحويل' },
    { id: 'new-count', label: 'inventory.kinds.count', icon: ClipboardCheck, group: 'create', to: '/inventory/operations/new?kind=count', perm: 'inventory.operations.write', app: 'inventory', keywords: 'count stocktake جرد' },
    { id: 'go-warehouses', label: 'nav.warehouses', icon: Warehouse, group: 'navigate', to: '/inventory/warehouses', perm: 'inventory.stock.read', app: 'inventory', keywords: 'warehouse مخزن' },
    { id: 'new-receipt', label: 'adv.newReceipt', icon: PackageCheck, group: 'create', to: '/inventory/receipts/new', perm: 'inventory.receipts.write', app: 'inventory', keywords: 'grn receive goods استلام بضاعة' },
    { id: 'new-landed', label: 'adv.newLanded', icon: Ship, group: 'create', to: '/inventory/landed-costs/new', perm: 'inventory.landed.write', app: 'inventory', keywords: 'freight customs landed شحن جمارك' },
    { id: 'go-trace', label: 'adv.trace', icon: ScanSearch, group: 'navigate', to: '/reports/inventory/trace', perm: 'inventory.stock.read', app: 'inventory', keywords: 'serial lot trace سيريال تشغيلة تتبع' },
    { id: 'go-expiry', label: 'adv.expiryReport', icon: CalendarClock, group: 'navigate', to: '/reports/inventory/expiry', perm: 'inventory.stock.read', app: 'inventory', keywords: 'expiry صلاحية' },
    { id: 'go-valuation', label: 'inventory.reports.valuation', icon: Coins, group: 'navigate', to: '/reports/inventory/valuation', perm: 'inventory.stock.read', app: 'inventory', keywords: 'تقييم' },
  ],
  reports: [
    { to: '/reports/inventory/valuation', group: 'inventory.reports.group', title: 'inventory.reports.valuation', desc: 'inventory.reports.valuationDesc', icon: Coins, color: 'var(--line-amber)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/movement', group: 'inventory.reports.group', title: 'inventory.reports.movement', desc: 'inventory.reports.movementDesc', icon: PackageSearch, color: 'var(--line-blue)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/reorder', group: 'inventory.reports.group', title: 'inventory.reports.reorder', desc: 'inventory.reports.reorderDesc', icon: RefreshCcw, color: 'var(--line-pink)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/profitability', group: 'inventory.reports.group', title: 'inventory.reports.profitability', desc: 'inventory.reports.profitabilityDesc', icon: TrendingUp, color: 'var(--line-teal)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/expiry', group: 'inventory.reports.group', title: 'adv.expiryReport', desc: 'adv.expiryDesc', icon: CalendarClock, color: 'var(--line-pink)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/trace', group: 'inventory.reports.group', title: 'adv.trace', desc: 'adv.traceDesc', icon: ScanSearch, color: 'var(--line-purple)', perm: 'inventory.stock.read', app: 'inventory' },
    { to: '/reports/inventory/grni', group: 'inventory.reports.group', title: 'adv.grni', desc: 'adv.grniDesc', icon: PackageOpen, color: 'var(--line-blue)', perm: 'inventory.receipts.read', app: 'inventory' },
  ],
  slots: {
    'document.view': DocumentStockPanel,
    'dashboard.widgets': InventoryWidget,
  },
};
