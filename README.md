# R3 Performance Review

Web app for R3 Robotics' half-yearly performance review cycles. It replaces the Excel files HR emails to
managers: HR sets up a cycle, managers review their reports in the app, HR calibrates and releases, and
employees see their own results. Every cycle stays in the app as history.

The framework (values, deliverables, skills, Talent Bar, grade rules) comes from the Notion page
*Scorecard Help Sheet for Leads* and the H1 2026 review Excel.

## How a cycle works

1. **HR creates a cycle** (e.g. "H2 2026", deadline 6 Jan 2027) under **HR**.
2. **HR downloads the Excel template**, fills in one row per person reviewed (name, work email,
   department, position, seniority, **manager**, three skills) and uploads it. The manager is the
   reviewer, and the reporting lines build the organisation tree. Heads who are not reviewed don't need
   a row: they appear at the top of the tree. The app lists every problem before anything is saved.
3. **HR presses "Initiate review cycle".** Each manager sees their direct reports under **My team**,
   as a tree they can open level by level.
4. **The manager writes the review.** Per dimension: a checklist suggests the level (the manager can
   change it) and a feedback comment for the employee. Per review: an action plan (employee sees it)
   and HR action points about salary / equity / promotion (never shown to the employee).
   Grades are calculated live.
5. **Two steps.** The manager submits, which locks it for them. Their own manager then sees it for the
   first time, can adjust it (every change is logged and visible to the manager) and **confirms** it,
   which completes it. If the manager's own manager is the CEO or is not reviewed (the heads), the
   manager's submit completes it: the CEO is never an approval step.
6. **Changes after submitting.** The manager (or, once completed, the second level) uses
   **Ask HR to reopen** with a short explanation. HR approves or declines under **HR admin → Requests**; HR can
   also reopen any review directly from the cycle page. A reopened review goes through both steps again.
7. **HR follows the cycle** in the **HR dashboard**: status counts (click one to filter), a reviews
   table with search and filters by manager, department and status, a Managers view and the
   Organisation tree. It updates itself every minute. HR can open and edit any review while it is open.
   The CEO can do the same, optionally: their edits are logged and don't change the steps.
8. **Discussion and changes.** Next to each review, the manager, the second level (once it reaches
   them), HR and the CEO see every logged change and can post messages, e.g. a manager questioning a
   change made by their own manager. "N new" next to a review shows activity since you last opened it.
   Read-only after release; never shown to the employee.
8. **HR releases all reviews at once** once every review is completed. Employees see their review,
   can mark it as read and leave a comment.

### Automatic emails

Sent for: a review submitted (to the second level), a review completed (to HR), a request to reopen
(to HR, with the explanation), HR's decision (to the person who asked), a review reopened, a cycle
initiated (to each manager) and a cycle released (to each employee). HR can turn each one off under
**HR admin → Emails**, which also lists every email. Emails never contain ratings, feedback or HR action
points. They are only sent once Microsoft sign-in and `MAIL_FROM` are set up (see
`docs/microsoft-sign-in-request.md`); until then they are listed but not sent. Test addresses
(`…@demo.r3.test`) are never sent to.

## Navigation

| Tab | Who | What |
| --- | --- | --- |
| Home | Managers and employees (not HR or the CEO) | What needs your attention |
| My team | Anyone who writes or confirms reviews, HR and CEO included | Reviews to write and to confirm (count in the tab), and your branch of the tree |
| HR dashboard (CEO: Dashboard) | HR admins and the CEO; where they land after signing in | The live view of a cycle; "Other cycles" to look back |
| HR admin | HR admins only | Cycles (create, set up, all past cycles, skill questionnaires from Notion), Requests, Access, Emails |
| My reviews | Everyone | Your own reviews after release |

## Skill questionnaires

Written in the Notion Skill Base (one page per skill with a Level / Behavior table). The app keeps a
copy: HR updates it with **HR admin → Cycles → Check Notion for changes**, sees every change, then
applies it. Each cycle keeps the questionnaire it was initiated with; updates apply to cycles
initiated afterwards. Setup: `docs/notion-skills.md` (a read-only Notion connection and the
`NOTION_TOKEN` secret).

## Who sees what

| Person | Sees | Can change |
| --- | --- | --- |
| HR admin (HR manager + one backup) | Every review, HR action points, change log | Everything while the cycle is open |
| CEO | Every review, HR action points, discussion and changes | Any review while the cycle is open (optional, logged; never an approval step; cannot reopen) |
| Manager (writes the review) | Their direct reports' reviews | Until they submit; then only by asking HR |
| Manager's manager (second level) | Those reviews once the manager has submitted them, HR action points included | Until they confirm; then only by asking HR |
| Anyone higher up | Nothing: each head's branch is independent | Nothing |
| Manager, later cycles | Earlier released reviews of their current reports. No HR action points | Nothing |
| Employee | Only their own review, after release. No HR action points or change log | Their read receipt and comment |

Your own review always follows the employee rule, even if you are an HR admin, the CEO or a manager:
you see it only after release, and never the HR action points about yourself.

The rules live in `src/access.js` and are covered by `test/access.test.js`.

## Scoring rules

- Scale 1–5: Poor, Basic, Intermediate, Advanced, Exceptional.
- Talent Bar: the H1 2026 Excel version (`src/shared/framework.js`); where the Excel and Notion differ, the
  Excel is the source of truth (Daria, 26 Nov). Radical Transparency is the first cultural value. Each
  cycle stores the bar it used, so later changes don't rewrite history.
- Per area (Culture, Deliverables, Skills): any 1 → Values Concern; any rating below the bar →
  Underperformer; every rating at least 1 above the bar → A-Player; otherwise Above the Bar.
- Overall: any Values Concern → Values Concern; 2+ areas A-Player → A-Player; any Underperformer →
  Underperformer; otherwise Above the Bar. (Same as the H1 2026 Excel formulas.)
- Checklist suggestion (Daria, 26 Nov): Poor if any Poor behaviour applies. Then go from Basic up and stop
  at the first No: if it's the first statement of a level, the level below (first Basic No → Poor); if
  it's a later statement, that level. All Yes → Exceptional.
- Grade rules confirmed by Daria on 26 Nov (the Excel formulas are the guiding principle). Radical
  Transparency's "Expert" statement from Notion is part of Exceptional.

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
   - `MAIL_FROM`: the mailbox automatic emails are sent from (once IT has set it up)
   - While testing with fake data only: `ALLOW_TEST_LOGIN=true`
4. **Run** to try it in the workspace. Open the app in its own browser tab: the small preview pane
   inside Replit may not keep you signed in. `npm run demo` (in the Shell) adds fictional people and a demo cycle
   (Elena Head → Alex Lead → Kim, Lee, Sam; Omar Head → Billie Lead → Pat, Robin); sign
   in with the test login as `hana.hr@demo.r3.test` (HR), `alex.lead@demo.r3.test` (manager),
   `elena.head@demo.r3.test` (Alex's manager: confirms his reviews), `chris.ceo@demo.r3.test` (CEO) or
   `kim.mid@demo.r3.test` (employee). `npm run demo:remove` deletes the demo cycle and people again.
5. **Deploy** (Deploy → Autoscale). Migrations run on every start.

The app refuses to start with test login on once Microsoft sign-in is configured, and on a deployment
unless `ALLOW_TEST_LOGIN_ON_DEPLOYMENT=true` is also set (only for a test deployment with fake data).

### Before real reviews go in

- Ask IT to register the app in Microsoft Entra ID: `docs/microsoft-sign-in-request.md` has the request.
- Set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `APP_BASE_URL`, `MAIL_FROM`, and optionally
  `MS_ALLOWED_EMAIL_DOMAINS=r3robotics.ai`. On first Microsoft sign-in the app links the person's
  Microsoft account to their email in the app; guest accounts are refused.
- **Turn test login off** (`ALLOW_TEST_LOGIN=false` or delete it). With test login on, anyone with the
  link can sign in as anyone.
- Use a fresh database without demo data, or run `npm run demo:remove`.
- In **HR admin → Access**, add the backup HR admin and the CEO.

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
- Deadline reminder emails (needs a scheduled job).
- An "in this cycle: yes/no" column for people who are not reviewed (to be decided).
- Importing the H1 2026 Excel as history (waiting for the full file).
- Self-assessment by employees.

## Project layout

```
src/app.js            Express app (security headers, sessions, routes)
src/access.js         who may see / change each review
src/routes/           pages: home & lists, HR, review form
src/roster.js         reading and checking the uploaded Excel
src/cycles.js         set-up, initiate, release, late changes, reopen requests
src/reviews.js        loading and saving reviews (two steps), change log
src/org.js            organisation tree from reporting lines
src/notify.js         automatic emails and the email log
src/shared/           framework, scoring and checklist rules (server + browser)
src/auth/             test login and Microsoft sign-in
migrations/           database schema
views/, public/       pages and styles
test/                 scoring and access tests
```
