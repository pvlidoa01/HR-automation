# Running the imported project

- Preserve the existing Node.js, Express, EJS, and PostgreSQL stack and application code.
- Use the **Start application** workflow: `PORT=5000 npm run dev`.
- Dependencies are installed from the existing `package.json`.
- The existing `DATABASE_URL` connects to the development PostgreSQL database.
- `SESSION_SECRET` is already stored securely; do not print it or commit it.
- Development-only settings: `ALLOW_TEST_LOGIN=true`, `INITIAL_HR_ADMIN_EMAIL=hana.hr@demo.r3.test`, and `INITIAL_HR_ADMIN_NAME=Hana HR`.
- `npm run demo` has populated fictional users and a Demo cycle with seven reviews.

## Trying the demo

Open `/login` and select a fictional user. HR: `hana.hr@demo.r3.test`; manager: `alex.lead@demo.r3.test`; department head: `elena.head@demo.r3.test`; CEO: `chris.ceo@demo.r3.test`; employee: `kim.mid@demo.r3.test`.

Test login allows anyone with the link to act as any user. Use fictional data only. If sign-in does not persist in the embedded preview, open the preview in a separate browser tab.

## Checks

`npm test` runs scoring/checklist tests. Access tests require a separate, disposable `TEST_DATABASE_URL` and wipe its public schema. Never point them at the demo database or a database containing real data.

## Before real use

Microsoft sign-in is not configured. Follow the existing README and `docs/microsoft-sign-in-request.md`, disable test login, and remove demo data before entering real employee information. This setup is a development demo, not a production-ready deployment.
