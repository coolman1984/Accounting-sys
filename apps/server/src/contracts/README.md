# Contracts — the sockets between modules

A module may import only from `kernel/`, from `contracts/` and from the two
core modules (`modules/system`, `modules/ledger`, which every edition ships).
Everything another module needs from a *removable* module is described here
as a type and reached at run time through the service registry
(`services.get('inventory')`, guarded by `services.has(...)` when optional).

So deleting a module's folder never breaks the build — the
`test/boundaries.test.ts` fitness test and the edition builds check it.
