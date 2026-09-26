import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The web side of the "mechano": every feature contributes navigation,
 * pages and command-palette actions through one small object. The shell
 * composes whatever modules are installed — nothing is hard-wired.
 */
export type NavSection = 'overview' | 'sales' | 'purchases' | 'banking' | 'accounting' | 'insights' | 'admin';

export interface NavItem {
  to: string;
  label: string; // i18n key
  icon: LucideIcon;
  section: NavSection;
  order: number;
  perm?: string;
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
  keywords?: string;
  keys?: string[];
}

export interface WebModule {
  id: string;
  nav?: NavItem[];
  routes: PageRoute[];
  commands?: Command[];
}

export const SECTION_ORDER: NavSection[] = ['overview', 'sales', 'purchases', 'banking', 'accounting', 'insights', 'admin'];

export type Page = ComponentType;
