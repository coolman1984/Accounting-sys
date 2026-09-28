import { createContext, useContext, type ReactNode } from 'react';
import type { HelpTopic, ReportLink, Slots, WebModule } from './registry';

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

/** Every help article, in module order. */
export function useHelpTopics(): HelpTopic[] {
  return useContext(ModulesContext).flatMap((m) => m.help ?? []);
}

/** The article for a page: the one whose route is the longest match of the path. */
export function helpFor(topics: HelpTopic[], path: string): HelpTopic | null {
  let best: { t: HelpTopic; len: number } | null = null;
  for (const t of topics) {
    for (const r of t.routes) {
      const hit = r === '/' ? path === '/' : path === r || path.startsWith(r + '/');
      if (hit && (!best || r.length > best.len)) best = { t, len: r.length };
    }
  }
  return best?.t ?? null;
}
