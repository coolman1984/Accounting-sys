import { BookOpenCheck, Wallet, Factory, Building2, Users, FileCheck2, Coins, Gauge, ClipboardList, Landmark, Package, Percent, ShoppingBag, Tags, Target, Truck, type LucideIcon } from 'lucide-react';

/** How each app looks in the catalogue (names and texts come from the dictionaries: apps.<id>.*). */
export const APP_META: Record<string, { icon: LucideIcon; color: string }> = {
  gl: { icon: BookOpenCheck, color: '#2563eb' },
  ar: { icon: ShoppingBag, color: '#16a34a' },
  ap: { icon: Truck, color: '#ea580c' },
  treasury: { icon: Landmark, color: '#0891b2' },
  tax: { icon: Percent, color: '#64748b' },
  co: { icon: Target, color: '#0d9488' },
  fx: { icon: Coins, color: '#b45309' },
  analysis: { icon: Gauge, color: '#7c3aed' },
  budget: { icon: ClipboardList, color: '#0369a1' },
  cashflow: { icon: Wallet, color: '#0f766e' },
  mfg: { icon: Factory, color: '#b45309' },
  assets: { icon: Building2, color: '#4338ca' },
  payroll: { icon: Users, color: '#be185d' },
  cheques: { icon: FileCheck2, color: '#15803d' },
  inventory: { icon: Package, color: '#9333ea' },
  purchasing: { icon: ClipboardList, color: '#db2777' },
  pricing: { icon: Tags, color: '#ca8a04' },
};

export interface AppLike {
  id: string;
  core: boolean;
  requires: string[];
}

/**
 * Turn an app on or off in a selection, keeping requirements consistent:
 * switching on also switches on what it needs; switching off also switches
 * off what depends on it.
 */
export function toggleApp(all: AppLike[], selected: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected);
  const byId = new Map(all.map((a) => [a.id, a]));
  if (on) {
    const add = (x: string) => {
      if (next.has(x)) return;
      next.add(x);
      for (const r of byId.get(x)?.requires ?? []) add(r);
    };
    add(id);
  } else {
    const drop = (x: string) => {
      if (!next.has(x) || byId.get(x)?.core) return;
      next.delete(x);
      for (const a of all) if (a.requires.includes(x)) drop(a.id);
    };
    drop(id);
  }
  return next;
}
