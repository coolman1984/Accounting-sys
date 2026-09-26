import { createContext, useContext, type ReactNode } from 'react';
import type { ReportLink, Slots, WebModule } from './registry';

const ModulesContext = createContext<WebModule[]>([]);

export function ModulesProvider({ modules, children }: { modules: WebModule[]; children: ReactNode }) {
  return <ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider>;
}

/** Every component contributed to a slot, in module order. */
export function useSlot<K extends keyof Slots>(name: K): NonNullable<Slots[K]>[] {
  return useContext(ModulesContext)
    .map((m) => m.slots?.[name])
    .filter((c): c is NonNullable<Slots[K]> => !!c);
}

export function useContributedReports(): ReportLink[] {
  return useContext(ModulesContext).flatMap((m) => m.reports ?? []);
}
