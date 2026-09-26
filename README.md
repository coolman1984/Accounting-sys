# Mizan · ميزان

**A modular, local-network, double-entry accounting system — English & Arabic, light & dark.**

نظام محاسبة بالقيد المزدوج، يعمل على شبكتك المحلية، بالعربي والإنجليزي، ووضع فاتح وداكن.

---

## Quick start

Requires **Node.js 22.13+**.

```bash
# Windows: double-click start.bat      macOS / Linux:
./start.sh
```

That installs dependencies, builds once, and starts the server. The console prints:

```
  This computer:   http://localhost:4800
  Other computers: http://192.168.1.20:4800
```

Open the first address on the server PC and any "Other computers" address from
the rest of the office. The first visit runs the setup wizard.

### تشغيل سريع

1. ثبّت **Node.js 22** على جهاز واحد (الخادم).
2. على ويندوز: شغّل `start.bat`.
3. افتح `http://localhost:4800` على نفس الجهاز، أو العنوان المكتوب بجوار «Other computers» من أي جهاز على نفس الشبكة.
4. أول مرة سيظهر معالج الإعداد: اسم الشركة، العملة، بداية السنة المالية، ثم حساب المدير.

## Development

```bash
npm install
npm run dev        # API on :4800 (auto-reload) + web on :5173 (hot reload)
npm test           # accounting end-to-end tests
npm run typecheck
npm run build && npm start
```

Configuration (environment variables): `MIZAN_PORT` (4800), `MIZAN_HOST`
(0.0.0.0), `MIZAN_DATA_DIR` (./data), `MIZAN_SESSION_HOURS` (12).

## What's inside

- Chart of accounts (bilingual tree), journal entries, fiscal years & year-end close
- Sales invoices, credit notes, purchase bills, debit notes — auto-posted
- Receipts & payments with allocation; customers & suppliers with statements
- Products & services, VAT (inclusive / exclusive)
- Trial balance, general ledger, income statement, balance sheet, cash flow,
  aging, VAT summary, dashboard
- Users & roles, audit trail, lock date, gap-free numbering, daily backups
- ⌘K / Ctrl+K command palette, printing, CSV export, mobile layout

Read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it is built and the
accounting rules it guarantees, and **[docs/ROADMAP.md](docs/ROADMAP.md)** for the plan.
