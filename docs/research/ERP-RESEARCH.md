# ERP research — what the big systems teach Mizan

> Written 2026-09-27. Scope: SAP S/4HANA, Oracle E-Business Suite, Microsoft
> Dynamics 365 Business Central, Odoo, ERPNext (Frappe) and Dolibarr — how
> they cut the product into modules, how they install and sell them, how they
> control access, how they present work to users, how they keep the books
> safe, and what that means for a **small / lower-mid company running Mizan on
> a local network**. Every conclusion ends in a concrete decision for Mizan
> (see §10 and `docs/DECISIONS.md`).

**Arabic summary / الخلاصة:** الأنظمة الكبيرة بتقسّم البرنامج لأقسام
مالية واضحة (الأستاذ العام، العملاء، الموردين، البنوك، الأصول، مراكز
التكلفة، الضرايب) وأقسام تشغيل (مشتريات، مخازن، مبيعات). كل قسم له
"بطاقة تعريف" بتقول هو محتاج مين، وله صلاحيات خاصة بيه. الصلاحيات بتتجمع
في "أدوار" والمستخدم ياخد دور أو أكتر. إحنا هناخد نفس الأفكار بشكل
مبسط يناسب شركة صغيرة على شبكة داخلية.

---

## 1. How the big systems cut the product

| Area | SAP S/4HANA | Oracle EBS | Business Central | Odoo | ERPNext |
|---|---|---|---|---|---|
| General ledger | FI-GL | GL | General Ledger | Accounting | Accounts |
| Receivables | FI-AR | AR | Receivables | Invoicing / Accounting | Accounts (Sales Invoice) |
| Payables | FI-AP | AP | Payables | Accounting (Bills) | Accounts (Purchase Invoice) |
| Cash & bank | FI-BL (bank accounting) | Cash Management (CE) | Cash Management | Accounting (Bank) | Accounts (Payment Entry, Bank Reconciliation) |
| Fixed assets | FI-AA | Assets (FA) | Fixed Assets | Assets | Assets |
| Management accounting | CO (cost centers, profit centers, internal orders) | Cost Mgmt / Projects | Dimensions, Cost Accounting | Analytic Accounting | Cost Centers + Accounting Dimensions |
| Tax | FI tax codes, reporting | E-Business Tax | VAT setup & statements | Taxes, fiscal positions | Tax Templates |
| Purchasing | MM-PUR | Purchasing (PO) | Purchase | Purchase | Buying |
| Inventory | MM-IM | Inventory (INV) | Inventory | Inventory | Stock |
| Sales & distribution | SD | Order Management | Sales | Sales | Selling |

Findings:

* The **finance core is always split the same way**: GL, AR, AP, Bank/Cash,
  Assets, Controlling, Tax. Operational modules (purchasing, inventory,
  sales) feed documents into it.
* **S/4HANA's biggest idea is the Universal Journal (ACDOCA):** FI and CO were
  merged into one line-item table carrying every dimension (cost center,
  profit center…). One posting, one truth; no reconciliation between
  "financial" and "management" books. ERPNext does the same with
  *Accounting Dimensions*: cost center and project are just columns on each
  GL entry, and every report can filter by them.
* Sub-ledgers (AR, AP, assets) never own balances; they post to control
  accounts in the GL and keep only open items (what is still owed).

**For Mizan:** keep one ledger table (already true — `journal_lines`) and add
the **cost center as a dimension on journal lines**, so the CO module is a
pure add-on: master data + reports, no second set of books.

## 2. How modules are packaged, installed and sold

* **Odoo** — every module has a manifest (`__manifest__.py`): `depends`
  (installed and loaded first), `application` (shown as a sellable app),
  `auto_install` (a *link module* such as `sale_crm` that installs itself
  when all the modules it bridges are present). Business logic that joins
  two apps lives in the link module, not inside either app.
* **Dolibarr** — every feature is a module switched on/off in *Setup →
  Modules*; only *Users* is mandatory. Each module declares its own rights.
* **Business Central** — features ship as *extensions* (apps) written in AL;
  an extension carries its **permission sets in code** and *permission set
  extensions* that add its objects to existing sets automatically when it is
  installed — no manual admin work after installing an app.
* **SAP** — components are licensed and activated per system; configuration
  lives in the IMG; code is organised in packages with explicit interfaces.

**For Mizan:**

1. A module = a folder with a **manifest** (`id`, `dependsOn` = hard,
   `optional` = soft, `apps` = what it sells, `permissions` with labels).
2. Cross-module behaviour goes through **contracts** (typed service
   interfaces that live in the kernel), **events** and **UI slots** — never
   through importing another module's files. Then deleting a module's
   folder cannot break the build (checked by a test, see §9).
3. Integration between two optional modules (e.g. *Purchasing ↔ Inventory*:
   "receive goods" button) is guarded by `services.has()` / `hasApp()` —
   the small-company equivalent of Odoo's link modules.
4. Modules bring their permissions and default role grants with them (like
   BC permission-set extensions): installing an app needs no admin work.

## 3. Access control (authorization)

| System | Unit of permission | Grouping | Data restriction |
|---|---|---|---|
| SAP | Authorization object + fields, `ACTVT` 01 create / 02 change / 03 display / 06 delete | Roles built in PFCG (single → composite), assigned to users | Organisational levels (company code, plant) in the role |
| Oracle EBS | Function (a page or sub-action) | Menus → Responsibilities; RBAC roles on top | Data access sets (which ledgers) |
| Business Central | Object permissions (R/I/M/D/X) | Permission sets, user groups | Security filters |
| ERPNext | Per DocType: read / write / create / delete / submit / cancel / report / export | Roles (users have many) | *User Permissions* limit records by linked values; permission levels hide fields |
| Dolibarr | Per module rights (read / create / modify / delete) | User groups | "only own records" options |

Common patterns:

* **Permission = object × action.** Actions are few and standard
  (display, create/change, post/submit, approve, delete, manage).
* **Roles are sets of permissions; users hold several roles.** Effective
  rights are the union.
* **Built-in templates** exist for common jobs; admins copy and adjust them.
* **Segregation of duties (SoD):** classic conflicts are *maintain vendors +
  pay vendors*, *create journal + post journal*, *maintain customers + post
  receipts*. Big systems run SoD checks; small ones at least warn.
* A second layer restricts **data** (which company, warehouse, own records).

**For Mizan (simple but professional):**

* Permission key = `module.object.action`, declared in code by the module
  with a label, grouped by page, e.g. `ar.invoices.post`,
  `treasury.payments.write`, `inventory.stock.read`.
* Actions: `read`, `write` (create & edit drafts), `post` (post/void),
  `approve`, `manage` (settings of that area).
* Roles in the database: name, description, permissions; users get many
  roles. Built-in roles *Administrator* (everything, locked), *Accountant*,
  *Viewer*, plus templates (*Sales clerk*, *Purchasing officer*,
  *Storekeeper*, *Cashier*).
* A switched-off module's permissions disappear from every role (already
  done by the Apps layer).
* The role editor shows **pages as rows and actions as columns** — the
  owner thinks in screens, not in keys.
* **SoD warnings** on the user screen when one person holds a known
  conflicting pair; not blocking (small companies often must combine jobs).
* Later (roadmap): data restrictions per warehouse / own documents.

## 4. User experience

* **SAP Fiori principles:** *role-based* (show each person only their work),
  *adaptive*, *simple* (only what is necessary), *coherent* (one interaction
  model everywhere), *delightful*.
* **Business Central Role Centers:** the home page is built for the job
  (cues/tiles with counts that open filtered lists).
* **Odoo:** every list has search facets, filters, *group by*, favourites;
  the same list/form pattern in every app; a *chatter* on each document
  (history + comments).
* **ERPNext:** "awesome bar" command search, workspaces per module.

**For Mizan:** already done — one grid everywhere (filters, group by,
favourites), ⌘K palette, top or side menus. Next UX items: role-aware home
page (tiles per module the user can open), a per-document activity trail
(from the audit log), and permission-aware buttons (hidden, not disabled,
when not allowed — Fiori "only what is necessary").

## 5. Keeping the books safe (patterns worth copying)

| Pattern | Seen in | Mizan status |
|---|---|---|
| Posted entries are immutable; correct by reversal | all | ✅ DB triggers |
| Every document produces its journal entry in the same transaction | all | ✅ |
| Period / fiscal-year lock dates | Odoo (lock dates), SAP (posting periods) | ✅ lock date + year close |
| Tax lock date separate from GL lock | Odoo | ➕ roadmap |
| Sub-ledger reconciled with control account | SAP, ERPNext payment ledger | ✅ health checks (stock, GRNI); ➕ AR/AP open items vs control account |
| Dimensions on ledger lines (cost center, project) | S/4 ACDOCA, ERPNext | ➕ CO module (this phase) |
| Audit trail: who, when, what | all | ✅ audit log |
| Maker–checker for risky actions | SAP workflows, Oracle approvals | ✅ PO approval; ➕ roadmap: journal approval |

## 6. Standard end-to-end processes (use cases)

* **Procure-to-pay (P2P):** requisition → purchase order → goods receipt →
  supplier invoice (3-way match) → payment. *Mizan: PO → GRN → bill (GRNI
  match) → payment ✅; requisition ➕ later.*
* **Order-to-cash (O2C):** quotation → sales order → delivery → invoice →
  collection → reporting. *Mizan: invoice → receipt ✅; quotation / sales
  order / delivery note ➕ roadmap.*
* **Record-to-report (R2R):** journals → reconciliations → close → statements.
  *Mizan: journals, statements, year close ✅; bank reconciliation ➕.*
* **Month-end close checklist (small company):** post all documents →
  reconcile bank & cash → review AR/AP ageing → stock count & valuation vs
  GL → accruals & depreciation → VAT return → lock the period → reports.
  *Mizan: the System health page already covers the automatic checks.*

## 7. Database & scaling

* SQLite in WAL mode: many readers, **one writer at a time**. Reports from
  2026 benchmarks: lock errors are negligible under ~20 concurrent writers;
  latency grows beyond that. PostgreSQL (MVCC) is the answer for many
  simultaneous writers.
* A small company on a LAN (5–30 users, a few hundred documents a day) sits
  far below that limit, and SQLite gives zero administration, a single file
  to back up, and very fast reads.
* **Decision:** stay on SQLite, keep the door to PostgreSQL open:
  * all SQL goes through the `Database` class (one adapter to replace);
  * SQL stays portable except a short, listed set of SQLite features
    (currently: `RAISE(ABORT)` in 32 triggers, `INSERT OR IGNORE` ×3,
    `ON CONFLICT … DO UPDATE` ×6 — also valid in PostgreSQL, `json_extract`
    ×1, `strftime` ×1, PRAGMAs in the adapter);
  * money is integers (portable), dates are ISO text (portable);
  * short synchronous transactions (no network calls inside);
  * **switch signals:** more than ~20 people posting at the same time,
    several branches writing over a WAN, or a need for replicas / reporting
    server.

## 8. Code organisation lessons from open source

* **Odoo:** addons folder, one folder per module, manifest, `depends`;
  models extended by inheritance (powerful but hard to trace).
* **ERPNext/Frappe:** metadata-driven DocTypes, hooks for cross-app events,
  roles on DocTypes; GL logic centralised in `accounts/general_ledger.py`.
* **Modular monolith practice:** each module exposes a public API; a static
  rule (e.g. dependency-cruiser) forbids importing another module's
  internals; a CI test turns violations into failures.

**For Mizan:** explicit contracts over inheritance (traceable), one posting
engine (the ledger service), an automated boundary test, and a generated
code map so anyone can find where a feature lives.

## 9. Documentation practices

* **ADRs** (Architecture Decision Records): short, numbered, append-only;
  a changed decision gets a new record that supersedes the old one.
* **Keep a Changelog:** human-written list of changes per version (Added /
  Changed / Fixed / Removed).
* **Docs as code:** docs live in the repo, change in the same commit as the
  code, and generated reference pages are checked by tests so they cannot
  go stale.

**For Mizan:** `docs/CHANGELOG.md`, `docs/DECISIONS.md` (ADR log),
`docs/LESSONS.md` (what we learned while building), `docs/MAP.md`
(generated from the code: modules, pages, routes, permissions, tables,
events, services — a test fails when it is out of date) and `CLAUDE.md`
(the working rules, including "update the docs with every change").

## 10. Decisions taken from this research

1. Finance split into **GL (core), Tax, AR, AP, Treasury, CO**; operations
   into **Inventory, Purchasing, Pricing**; shared master data (partners,
   products) and the document & payment engines are infrastructure, not
   sold alone.
2. **Manifest + contracts + events + slots**; no cross-module imports;
   verified by a boundary test and by building "editions" that physically
   leave modules out.
3. **Roles & page-level permissions** (`module.object.action`), built-in
   role templates, SoD warnings.
4. **Cost centers as a ledger dimension** (CO), reports by cost center.
5. **SQLite now, PostgreSQL-ready** by keeping SQL portable and isolated.
6. **Docs system** with changelog, ADRs, lessons and a generated code map.

## Sources

* SAP S/4HANA Finance (GL, AP/AR, ACDOCA): <https://www.erpresearch.com/en-us/sap-s4-hana-finance-accounting-module>
* SAP FI sub-modules: <https://www.tutorialspoint.com/sap_fico/sap_fi_submodules.htm>
* SAP CO overview: <https://www.saponlinetutorials.com/sap-co-module-overview/>, <https://www.erpfixers.com/blog/2021/6/29/controlling-in-s4hana-6bd2m>
* SAP roles & PFCG: <https://learning.sap.com/courses/technical-implementation-and-operation-i-of-sap-s-4hana-and-sap-business-suite/maintaining-user-authorizations-with-roles-and-profiles>, <https://sap-authorization-universe.com/2021/03/13/basics-abap-pfcg-authorization-objects-and-authorization-fields/>
* SAP segregation of duties: <https://xiting.com/en/sap-knowledge/segregation-of-duties/>, <https://www.safepaas.com/blog/common-segregation-of-duties-conflicts-and-how-to-fix-them/>
* SAP Fiori design principles: <https://www.sap.com/design-system/fiori-design-web/v1-108/discover/sap-design-system/vision-and-mission/design-principles>
* Oracle EBS security guide: <https://docs.oracle.com/cd/E26401_01/doc.122/e22952.pdf>
* Business Central permission sets & role centers: <https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-entitlements-and-permissionsets-overview>, <https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-designing-role-centers>
* Odoo module manifests: <https://www.odoo.com/documentation/17.0/developer/reference/backend/module.html>
* Odoo lock dates & reconciliation: <https://github.com/odoo/odoo/blob/14.0/addons/account/models/account_move.py>
* ERPNext roles & user permissions: <https://docs.frappe.io/erpnext/user/manual/en/role-based-permissions>, <https://docs.frappe.io/erpnext/user-permissions>
* ERPNext accounting dimensions: <https://deepwiki.com/frappe/erpnext/3.3-accounting-dimensions-and-cost-centers>, <https://github.com/frappe/erpnext/blob/develop/erpnext/accounts/general_ledger.py>
* Dolibarr modules & permissions: <https://wiki.dolibarr.org/index.php?title=Permissions_En>, <https://wiki.dolibarr.org/index.php?title=Module_development>
* Modular monolith boundaries: <https://milanjovanovic.tech/blog/internal-vs-public-apis-in-modular-monoliths>, <https://docs.synapsestudios.com/implementation/frameworks/nest/modular-monolith>
* SQLite vs PostgreSQL limits: <https://sesamedisk.com/sqlite-in-production-2026-benchmarks-limits/>, <https://www.sqliteforum.com/p/optimizing-sqlite-for-multi-user>
* P2P / O2C / R2R: <https://en.wikipedia.org/wiki/Procure-to-pay>, <https://en.wikipedia.org/wiki/Order_to_cash>, <https://en.wikipedia.org/wiki/Record_to_report>
* ADRs & changelog: <https://github.com/adr/madr>, <https://www.martinfowler.com/bliki/ArchitectureDecisionRecord.html>
