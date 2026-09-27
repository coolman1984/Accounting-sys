import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The web side of the "mechano": every feature contributes navigation,
 * pages and command-palette actions through one small object. The shell
 * composes whatever modules are installed — nothing is hard-wired.
 */
export type NavSection = 'overview' | 'sales' | 'purchases' | 'inventory' | 'banking' | 'accounting' | 'insights' | 'admin';

/** Shown only when one of these apps is on (see the Apps page). */
export type AppGate = string | string[];

export interface NavItem {
  to: string;
  label: string; // i18n key
  icon: LucideIcon;
  /** Where it sits; a function lets it move when an app is off (products live under Inventory, else Sales/Purchases). */
  section: NavSection | ((hasApp: (id: string) => boolean) => NavSection);
  order: number;
  perm?: string;
  app?: AppGate;
  /** Exact match for active state (e.g. the dashboard at "/"). */
  end?: boolean;
}

export interface PageRoute {
  path: string;
  element: ReactNode;
}

export interface Command {
  id: string;
  label: string; // i18n key
  icon: LucideIcon;
  group: 'navigate' | 'create';
  to: string;
  perm?: string;
  app?: AppGate;
  keywords?: string;
  keys?: string[];
}

/** A report tile on the Reports hub. */
export interface ReportLink {
  to: string;
  group: string; // i18n key of the group title
  title: string; // i18n key
  desc: string; // i18n key
  icon: LucideIcon;
  color: string;
  perm?: string;
  app?: AppGate;
}

/**
 * Slots let a module add UI inside another module's page without either
 * importing the other (e.g. inventory adds a "stock movements" panel to
 * invoices and a widget to the dashboard).
 */
export interface Slots {
  'document.view'?: ComponentType<{ documentId: number; kind: string; status: string }>;
  'dashboard.widgets'?: ComponentType;
}

export interface WebModule {
  id: string;
  nav?: NavItem[];
  routes: PageRoute[];
  commands?: Command[];
  reports?: ReportLink[];
  slots?: Slots;
}

export const SECTION_ORDER: NavSection[] = ['overview', 'sales', 'purchases', 'inventory', 'banking', 'accounting', 'insights', 'admin'];

export type Page = ComponentType;
