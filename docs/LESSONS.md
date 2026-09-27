# Lessons learned

Traps already hit, so nobody hits them twice. Newest first. Add one whenever a bug had a
non-obvious cause or a tool behaved unexpectedly.

## Accounting & data

- **Reversals must mirror, not re-validate.** A reversal copies a posted entry; if it re-checks
  dimensions (cost center active, CO app on) it can become impossible to undo a posting. Pass `mirror`.
- **Read back every column you write.** `ledger.entry()` did not select `cost_center_id`, so reversals
  silently dropped it. When adding a column, grep every `SELECT` of that table.
- **Aging must reconcile to the ledger**: unallocated payments are a separate column, not ignored.
- **The last unit out takes the remaining value** — otherwise rounding leaves "ghost" stock value.
- Voids always run their listeners even when the app is off, so switching an app off never leaves
  stock or balances half-undone.

## Modules & permissions

- **`useConfirm()` resolves to `{ ok, date? }`, not a boolean.** `if (await confirm(…))` is always true
  and would void or delete without asking. Always test `.ok`.
- **Header guessing needs word boundaries for short words** ("in" matches "description"), but not for
  prefixes like "ref" → "reference": list the long form too.
- **A voided payment leaves a +/− pair on the bank account** that the bank never sees; exclude reversed
  pairs from open items, or reconciliation never gets clean.

- **A screen that waits for optional data must not wait forever.** The invoice editor waited for tax
  codes before adding the first line; with Tax off it never appeared. Gate on `hasApp()` too.
- **Hiding a menu item is not access control on the page.** A typed or bookmarked link skipped the
  menu and spun forever on a 403. Every route is gated (`gateFor` in `core/registry.ts`).
- **Reference lists vs. management rights.** Guarding `GET /taxes` with `tax.codes.read` blocked a
  sales clerk from choosing VAT. Lists used to fill documents are `auth` + `assertApp`.
- **Permission objects cannot be both a leaf and a branch** in the dictionaries
  (`pricing.override` next to `pricing.lists.*` broke `perms.objects.pricing`). Keep three parts.
- Two modules augmenting the same `ServiceMap` key gives TS2717 — put shared types in `contracts/` once.
- Renamed app ids need a data migration (`kernel/apps.ts` `RENAMED`), or companies lose their switches.
- Every folder in `web/src/modules` must be in the edition map — `auth` (login/setup) was forgotten
  at first; the edition check caught it.

## Tools

- `@fastify/static` pre-indexes files at start; after a rebuild use `wildcard: true`, and `res.header`
  (not `setHeader`) in `setHeaders`.
- GitHub merge API needs the full 40-character SHA.
- `node:sqlite` prints an ExperimentalWarning — run with `--disable-warning=ExperimentalWarning`.
- In e2e scripts, find buttons by their real label ("Continue", "Create my books"), not a guess.
