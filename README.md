# R3 Performance Review

Web app for R3 Robotics' half-yearly performance review cycles. It replaces the Excel files HR emails to
managers: HR sets up a cycle, managers review their reports in the app, HR calibrates and releases, and
employees see their own results. Every cycle stays in the app as history.

The framework (values, deliverables, skills, Talent Bar, grade rules) comes from the Notion page
*Scorecard Help Sheet for Leads* and the H1 2026 review Excel.

## How a cycle works

1. **HR creates a cycle** (e.g. "H2 2026", deadline 6 Jan 2027) under **HR**.
2. **HR downloads the Excel template**, fills in one row per person (name, work email, department,
   position, seniority, reviewer, three skills) and a head per department, then uploads it. The app
   lists every problem before anything is saved.
3. **HR presses "Initiate review cycle".** Each manager now sees only their own reports under **My team**.
   No emails are sent in this version: HR shares the app link and sees who is behind on the cycle page.
4. **Managers fill in each review.** Per dimension: a checklist suggests the level (the manager can
   change it) and a feedback comment for the employee. Per review: an action plan (employee sees it)
   and HR action points about salary / equity / promotion (never shown to the employee).
   Grades are calculated live. **Submit** locks the review; HR can reopen it.
5. **HR calibrates**: HR admins edit reviews directly. Every change is logged and the manager sees the log.
6. **HR releases all reviews at once** once every review is submitted. Employees see their review,
   can mark it as read and leave a comment.

## Who sees what

| Person | Sees | Can change |
| --- | --- | --- |
| HR admin (HR manager + one backup) | Every review, HR action points, change log | Everything while the cycle is open |
| CEO ("sees all reviews") | Every review, HR action points, change log | Nothing |
| Department head | Reviews in their department, once the manager submits. No HR action points | Nothing |
| Manager (reviewer) | Their own reports | Their reviews until they submit |
| Manager, later cycles | Earlier released reviews of their current reports. No HR action points | Nothing |
| Employee | Only their own review, after release. No HR action points or change log | Their read receipt and comment |

Your own review always follows the employee rule, even if you are an HR admin, the CEO or a department
head: you see it only after release, and never the HR action points about yourself.

The rules live in `src/access.js` and are covered by `test/access.test.js`.

## Scoring rules

- Scale 1–5: Poor, Basic, Intermediate, Advanced, Exceptional.
- Talent Bar: the Notion version (`src/shared/framework.js`). Each cycle stores the bar it used, so later
  changes don't rewrite history.
- Per area (Culture, Deliverables, Skills): any 1 → Values Concern; any rating below the bar →
  Underperformer; every rating at least 1 above the bar → A-Player; otherwise Above the Bar.
- Overall: any Values Concern → Values Concern; 2+ areas A-Player → A-Player; any Underperformer →
  Underperformer; otherwise Above the Bar. (Same as the H1 2026 Excel formulas.)
- Checklist suggestion: Poor if any Poor behaviour applies or every Basic statement is No; otherwise the
  highest level where every statement is Yes (Basic at least).

Code: `src/shared/scoring.js`, `src/shared/checklist.js` (also used in the browser).
Skill behaviour statements come from the Notion Skill Base (`src/seed/skills.json`).

## Set up on Replit

1. **Create the Repl** from the GitHub repo (Create Repl → Import from GitHub).
2. **Add a database:** in the Repl, open the *Database* tool and create a PostgreSQL database.
   Replit adds `DATABASE_URL` automatically.
3. **Add Secrets** (see `.env.example`):
   - `SESSION_SECRET`: a random string of 32+ characters
   - `INITIAL_HR_ADMIN_EMAIL` and `INITIAL_HR_ADMIN_NAME`: the HR manager
   - `APP_BASE_URL`: the app's public address (after the first deploy)
   - While testing with fake data only: `ALLOW_TEST_LOGIN=true`
4. **Run** to try it in the workspace. Open the app in its own browser tab: the small preview pane
   inside Replit may not keep you signed in. `npm run demo` (in the Shell) adds fictional people and a demo cycle; sign
   in with the test login as `hana.hr@demo.r3.test` (HR), `alex.lead@demo.r3.test` (manager),
   `elena.head@demo.r3.test` (department head), `chris.ceo@demo.r3.test` (CEO) or
   `kim.mid@demo.r3.test` (employee). `npm run demo:remove` deletes the demo cycle and people again.
5. **Deploy** (Deploy → Autoscale). Migrations run on every start.

The app refuses to start with test login on once Microsoft sign-in is configured, and on a deployment
unless `ALLOW_TEST_LOGIN_ON_DEPLOYMENT=true` is also set (only for a test deployment with fake data).

### Before real reviews go in

- Ask IT to register the app in Microsoft Entra ID: `docs/microsoft-sign-in-request.md` has the request.
- Set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `APP_BASE_URL`, and optionally
  `MS_ALLOWED_EMAIL_DOMAINS=r3robotics.ai`. On first Microsoft sign-in the app links the person's
  Microsoft account to their email in the app; guest accounts are refused.
- **Turn test login off** (`ALLOW_TEST_LOGIN=false` or delete it). With test login on, anyone with the
  link can sign in as anyone.
- Use a fresh database without demo data, or run `npm run demo:remove`.
- In **HR → Access settings**, add the backup HR admin and the CEO (read-only).

Note: Replit hosts in the US. Decided for the MVP; revisit if EU hosting becomes a requirement.

## Develop and test locally

```sh
npm install
export DATABASE_URL=postgresql://localhost/r3dev SESSION_SECRET=$(openssl rand -hex 32) ALLOW_TEST_LOGIN=true INITIAL_HR_ADMIN_EMAIL=you@r3robotics.ai
npm run dev
TEST_DATABASE_URL=postgresql://localhost/r3test npm test   # wipes that database
```

## Not in this version

- Importing employees and reporting lines from Personio (needs Personio Core Pro API access).
- Automatic emails (launch notice, deadline reminders).
- Importing the H1 2026 Excel as history (waiting for the full file).
- Self-assessment by employees.

## Project layout

```
src/app.js            Express app (security headers, sessions, routes)
src/access.js         who may see / change each review
src/routes/           pages: home & lists, HR, review form
src/roster.js         reading and checking the uploaded Excel
src/cycles.js         set-up, initiate, release, late changes
src/reviews.js        loading and saving reviews, change log
src/shared/           framework, scoring and checklist rules (server + browser)
src/auth/             test login and Microsoft sign-in
migrations/           database schema
views/, public/       pages and styles
test/                 scoring and access tests
```
