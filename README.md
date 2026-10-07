# SunFrame ERP (prototype)

A front-end-only ERP prototype for a solar mounting-structure manufacturer. It walks the full order-to-cash and
procure-to-pay flow in the browser: **CRM** (pipeline, accounts) → **Sales** (BOM, quote, client PO, sales order,
manufacturing order) → **Procurement** (purchase requests, approvals, supplier POs, GRN) → **Inventory** →
**Manufacturing** (line planning board) → **Dispatch** (LR, proof of delivery) → **Finance** (receivables, payables,
payments) plus **Documents**, **HRMS** (employees, leave, payroll) and **Settings** (company, users, approval rules).

Built with React 19, TypeScript, Vite and zustand. There is no backend — everything runs and is stored in your browser.

> **Demo only.** All companies, people, emails (`.example` domain), phone numbers (`+91 00000 …`), GSTINs and
> documents are fictional sample data. Do not enter real personal, client or financial information.

## Getting started

Requires Node.js 20.19+ (or 22.12+) and npm.

```bash
npm install        # install dependencies
npm run dev        # start the dev server (Vite prints the URL, e.g. http://localhost:5173)
npm run build      # type-check (tsc -b) and build to dist/
npm run preview    # serve the production build locally
npm run lint       # oxlint
```

On first load the app seeds sample records (leads, orders, suppliers, stock, employees, …) and opens the Login screen.
Sign in with one of the test accounts below.

To reset to fresh sample data, clear the site data for the dev URL in your browser (localStorage, sessionStorage and
IndexedDB) and reload.

## Signing in — simulated, not secure authentication

There is no backend. Sign-in is a **local prototype session**: a few fictional test accounts are bundled in the client
(`src/lib/auth.ts`) and mapped to existing users, whose roles and permissions come from the user records.
Anyone can read these credentials — do not reuse them anywhere real, and do not treat this as access control.

| Account | Email | Password | Role |
|---|---|---|---|
| Abhineet Suryawanshi | `abhineet@sunframe.example` | `SunFrame@admin` | Admin (approves PRs, assigns lines, adds users) |
| Meera Iyer | `meera@sunframe.example` | `SunFrame@meera` | User · Purchase executive (sees only her own PRs) |
| Dinesh Patil | `dinesh@sunframe.example` | `SunFrame@dinesh` | User · Production supervisor |

The same list is in the collapsed **Test accounts** section on the Login screen.

For quick demos the Login form **opens prefilled with the admin test account** (Abhineet). The fields stay editable,
nothing signs in automatically — click **Sign in** — and after **Log out** the form is prefilled again. The prefill
lives only in the Login component's state; the password is never written to storage or logged.

- Every route shows Login while signed out; after sign-in the app opens on Dashboard.
- The session is only the signed-in user id in `sessionStorage` (key `sunframe-session`): it survives a refresh in the
  same tab, is cleared by **Log out** (header user menu), and a new browser session asks to sign in again.
- Entered passwords are checked in memory and are never stored or logged.
- Business records (`localStorage` key `sunframe-erp-v1`) and uploaded files (IndexedDB) are separate and untouched by
  sign-in or log-out.
- To act as another person, log out and sign in with their account. Users added in Settings have no password, so they
  cannot sign in in this prototype.

## Demo prefill — sample values in creation forms

To make walkthroughs quick, creation forms open with **valid, fictional sample values** (`src/lib/samples.ts`).
Everything stays editable and normal validation, roles and workflow prerequisites still apply.

- **Order of precedence:** saved values when editing → values from the linked record (BOM → quote → Client PO → SO →
  MO; PR → PO; PO → GRN) → generic fictional samples. A saved record or a user edit is never overwritten.
- **No side effects:** samples are computed once when the form opens (React `useState` initialisers). Opening,
  re-rendering or cancelling a form creates no records, reserves no stock, approves no PR, dispatches nothing and
  records no payment — that only happens on Save / Confirm through the existing store actions.
- **Coherent data:** existing materials, units and suppliers are reused; references (lead company, Client PO number,
  supplier quotation ref, GRN number, LR number, UTR, employee/user names and emails) are checked to be unused.
  PR-linked POs keep the approved quantities. Stock adjustments never go below the reserved quantity. Pending PRs are
  never preselected on a PO. The MO reconciliation note is prefilled when the SO and BOM quantities differ, but must
  still be confirmed.
- **Not prefilled (entered by the user):**
  - **New BOM:** starts with exactly one material row. Saved BOMs always load their own rows, and deleted rows never
    come back.
  - **New quote:** only real context is carried in: one line with the BOM's product and output quantity. The rate,
    charges and terms are left empty, except company defaults set in Settings → Company. Saved quotes and revisions
    keep their own data.
  - **Client PO:** a document upload only, with no line items, amounts or terms. After saving it is read-only (view or
    download, also listed in Documents). Nothing is extracted from the file.
  - **Sales order:** items come from the won quote. Payment terms, delivery terms, delivery address and T&Cs are entered
    or reviewed in the SO form.
  - **Payments (receivables and payables):** the amount starts blank, with a *Full balance* shortcut. Status comes only
    from cumulative recorded amounts: none is Pending, below the total is Partially paid, the full total is Paid.
    Attaching a payment proof never changes the status.
- **Sample attachments:** Client PO, supplier quotation, GRN challan, POD, payment proof and document uploads offer a
  **generated PDF** (real content, `SAMPLE-…pdf`, "FICTIONAL SAMPLE" on every page). The file chooser labels it
  *Sample · fictional*, lets you Preview, Remove or Replace it, and offers **Use sample file** when empty. It is stored
  in IndexedDB only when the form is saved. At dispatch the POD sample is offered, not attached (PODs usually arrive later).
- People, companies and emails are fictional (`.example` domain). Company terms come from Settings → Company when set.

Forms that need a prerequisite: Quote (needs a BOM), Client PO upload (lead closed as won),
SO (Client PO), MO (SO + BOM), GRN (approved PO), dispatch (finished goods ready), receipt/payment (an outstanding
receivable/payable), stock adjustment (a material), leave (an active employee), payroll (employees and a month without
a run), supplier quotation and supplier PO (an active supplier). Real documents must always be chosen by the user.

## Limitations

- **Simulated authentication.** Test credentials are bundled in the client and visible to anyone; there is no server,
  no password hashing and no real access control. Role checks in the UI are for demonstrating the workflow only.
- **Local browser storage only.** Records live in `localStorage` (`sunframe-erp-v1`), the session in `sessionStorage`
  (`sunframe-session`) and attachments in IndexedDB. Nothing is shared between browsers, devices or users, data can be
  lost when site data is cleared, and storage quotas limit large attachments.
- **Sample records.** The app seeds fictional data on first run and creation forms prefill fictional values (see
  above). Generated PDFs are marked *FICTIONAL SAMPLE*. Treat every figure as illustrative.
- No integrations (email, GST portal, banking, e-way bill) and no
  automated test suite in this repository.
