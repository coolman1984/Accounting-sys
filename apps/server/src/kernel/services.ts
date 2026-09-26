/**
 * Typed service registry — the "sockets" modules plug into.
 *
 * A module publishes its public API with `services.provide('ledger', api)` and
 * declares its type by augmenting `ServiceMap`:
 *
 *   declare module '../../kernel/services.js' {
 *     interface ServiceMap { ledger: LedgerService }
 *   }
 *
 * Other modules only ever talk to that interface, never to internals.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServiceMap {}

export class ServiceRegistry {
  private map = new Map<string, unknown>();

  provide<K extends keyof ServiceMap>(name: K, service: ServiceMap[K]): void {
    if (this.map.has(name as string)) throw new Error(`Service "${String(name)}" already provided`);
    this.map.set(name as string, service);
  }

  get<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
    const s = this.map.get(name as string);
    if (!s) throw new Error(`Service "${String(name)}" is not available — is its module enabled?`);
    return s as ServiceMap[K];
  }

  has(name: keyof ServiceMap): boolean {
    return this.map.has(name as string);
  }
}
