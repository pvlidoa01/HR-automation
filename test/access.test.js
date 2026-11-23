// End-to-end access tests against a real PostgreSQL database.
// Needs TEST_DATABASE_URL pointing at an EMPTY database that may be wiped.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  test('access tests', { skip: 'Set TEST_DATABASE_URL to run the access tests.' }, () => {});
} else {
  process.env.DATABASE_URL = dbUrl;
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.ALLOW_TEST_LOGIN = 'true';
  process.env.INITIAL_HR_ADMIN_EMAIL = '';

  const { default: request } = await import('supertest');
  const { pool } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { createApp } = await import('../src/app.js');
  const { validateRoster } = await import('../src/roster.js');
  const { saveRoster, initiateCycle } = await import('../src/cycles.js');
  const { TALENT_BAR } = await import('../src/shared/framework.js');

  const E = (n) => `${n}@t.test`.toLowerCase();
  let app;
  const ids = {};

  async function makeCycle(name, rows) {
    const c = (await pool.query('INSERT INTO cycles (name, talent_bar) VALUES ($1, $2) RETURNING id', [name, JSON.stringify(TALENT_BAR)])).rows[0];
    const skills = (await pool.query('SELECT name FROM skills')).rows.map((r) => r.name);
    const v = validateRoster({
      employees: rows.map(([emp, dept, rev], i) => ({
        rowNumber: i + 2, employeeName: emp, employeeEmail: E(emp), department: dept, position: 'Engineer', seniority: 'Mid',
        reviewerName: rev, reviewerEmail: E(rev), skill1: 'Problem Solving', skill2: 'Project Management', skill3: 'Procurement',
      })),
    }, skills);
    assert.equal(v.errorCount, 0, JSON.stringify(v.rows.map((r) => r.errors)));
    await saveRoster(c.id, v, 'test');
    return c.id;
  }

  async function reviewId(cycleId, employee) {
    return (await pool.query('SELECT r.id FROM reviews r JOIN users u ON u.id = r.employee_id WHERE r.cycle_id = $1 AND u.email = $2', [cycleId, E(employee)])).rows[0].id;
  }

  async function as(name) {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await agent.post('/login/test').type('form').send({ _csrf: token, email: E(name) });
    assert.equal(res.status, 302);
    const home = await agent.get('/me');
    agent.csrf = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
    return agent;
  }

  async function ver(agent, id) {
    const page = await agent.get(`/reviews/${id}`);
    const m = page.text.match(/name="version" value="([^"]+)"/);
    return m ? m[1] : 'none';
  }

  async function postReview(agent, id, fields) {
    const version = await ver(agent, id);
    return agent.post(`/reviews/${id}`).type('form').send({ _csrf: agent.csrf, version, ...fields });
  }

  const allRatings = (v) => Object.fromEntries(
    ['radical_transparency', 'impact', 'ownership', 'complexity', 'quality', 'speed', 'skill1', 'skill2', 'skill3'].map((k) => [`rating[${k}]`, String(v)]),
  );

  before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate({ quiet: true });
    await pool.query("INSERT INTO users (email, name, global_role) VALUES ($1, 'hr', 'hr_admin'), ($2, 'ceo', 'viewer_all')", [E('hr'), E('ceo')]);
    app = createApp();
    // Cycle 1 reporting lines (heads are not reviewed):
    //   headEng -> mA -> emp1, emp2;  headEng -> mB -> emp3;  headOps -> mC -> emp4
    ids.c1 = await makeCycle('C1', [
      ['emp1', 'Eng', 'mA'], ['emp2', 'Eng', 'mA'], ['emp3', 'Eng', 'mB'], ['emp4', 'Ops', 'mC'],
      ['mA', 'Eng', 'headEng'], ['mB', 'Eng', 'headEng'], ['mC', 'Ops', 'headOps'],
    ]);
    await initiateCycle(ids.c1);
    ids.r1 = await reviewId(ids.c1, 'emp1');
    ids.r3 = await reviewId(ids.c1, 'emp3');
    ids.r4 = await reviewId(ids.c1, 'emp4');
    ids.rA = await reviewId(ids.c1, 'mA');
  });

  after(async () => {
    await pool.end();
  });

  test('a manager sees their own report but not another manager\'s', async () => {
    const mA = await as('mA');
    assert.equal((await mA.get(`/reviews/${ids.r1}`)).status, 200);
    assert.equal((await mA.get(`/reviews/${ids.r3}`)).status, 404);
    assert.equal((await mA.get(`/reviews/${ids.r4}`)).status, 404);
    const post = await postReview(mA, ids.r3, { action: 'save', 'rating[impact]': '5' });
    assert.equal(post.status, 404);
  });

  test('an employee cannot see their review before release, or edit it', async () => {
    const emp1 = await as('emp1');
    assert.equal((await emp1.get(`/reviews/${ids.r1}`)).status, 404);
    const post = await postReview(emp1, ids.r1, { action: 'save', 'rating[impact]': '5' });
    assert.equal(post.status, 404);
    const me = await emp1.get('/me');
    assert.doesNotMatch(me.text, /href="\/reviews\//);
  });

  test('requests without the form token are refused', async () => {
    const mA = await as('mA');
    const res = await mA.post(`/reviews/${ids.r1}`).type('form').send({ action: 'save', 'rating[impact]': '3' });
    assert.equal(res.status, 403);
  });

  const status = async (id) => (await pool.query('SELECT status FROM reviews WHERE id = $1', [id])).rows[0].status;
  const rating = async (id, dim) => (await pool.query('SELECT rating FROM review_dimensions WHERE review_id = $1 AND dimension = $2', [id, dim])).rows[0]?.rating;
  const emails = async (kind) => (await pool.query('SELECT to_email FROM email_outbox WHERE kind = $1 ORDER BY id', [kind])).rows.map((r) => r.to_email);

  test('two steps: manager submits, their manager sees it only then, adjusts it and confirms it', async () => {
    const mA = await as('mA');
    const headEng = await as('headEng');
    const headOps = await as('headOps');
    assert.equal((await headEng.get(`/reviews/${ids.r1}`)).status, 404, 'draft hidden from the second level');
    const early = await postReview(headEng, ids.r1, { action: 'submit', ...allRatings(4) });
    assert.equal(early.status, 404, 'second level cannot act before the manager submits');

    const incomplete = await postReview(mA, ids.r1, { action: 'submit', 'rating[impact]': '3' });
    assert.equal(incomplete.status, 422);

    const ok = await postReview(mA, ids.r1, { action: 'submit', ...allRatings(3),
      'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE',
    });
    assert.equal(ok.status, 302);
    assert.equal(await status(ids.r1), 'submitted');
    assert.deepEqual(await emails('review_submitted'), [E('headEng')], 'second level is asked to confirm');

    await postReview(mA, ids.r1, { action: 'save', ...allRatings(5) });
    assert.equal(await rating(ids.r1, 'impact'), 3, 'locked for the manager after submit');

    const page = await headEng.get(`/reviews/${ids.r1}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /SECRET-SALARY-NOTE/, 'second level sees HR action points');
    assert.match(page.text, /name="rating\[/, 'and can edit');
    assert.match(page.text, /Confirm review/);
    assert.equal((await headOps.get(`/reviews/${ids.r1}`)).status, 404, 'another head sees nothing');

    const adjust = await postReview(headEng, ids.r1, { action: 'save', ...allRatings(3), 'rating[quality]': '4',
      'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE' });
    assert.equal(adjust.status, 302);
    assert.equal(await status(ids.r1), 'submitted', 'saving does not confirm');
    assert.match((await mA.get(`/reviews/${ids.r1}`)).text, /Quality: rating/, 'manager sees the change in the log');

    const confirm = await postReview(headEng, ids.r1, { action: 'submit', ...allRatings(3), 'rating[quality]': '4',
      'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE' });
    assert.equal(confirm.status, 302);
    assert.equal(await status(ids.r1), 'closed');
    assert.deepEqual(await emails('review_closed'), [E('hr')], 'HR is told only when it is complete');

    await postReview(headEng, ids.r1, { action: 'save', ...allRatings(1) });
    assert.equal(await rating(ids.r1, 'impact'), 3, 'locked for both after confirming');
  });

  test('a manager who reports to a head with no manager of their own: one step only', async () => {
    const headEng = await as('headEng');
    const res = await postReview(headEng, ids.rA, { action: 'submit', ...allRatings(3) });
    assert.equal(res.status, 302);
    assert.equal(await status(ids.rA), 'closed');
    const mA = await as('mA');
    assert.equal((await mA.get(`/reviews/${ids.rA}`)).status, 404, 'own review stays hidden until release');
  });

  test('asking HR to reopen: needs an explanation, HR approves, both can edit, two steps again', async () => {
    const mA = await as('mA');
    const emp1 = await as('emp1');
    const noReason = await mA.post(`/reviews/${ids.r1}/request-change`).type('form').send({ _csrf: mA.csrf, reason: '' });
    assert.equal(noReason.status, 302);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM change_requests')).rows[0].n, 0);
    assert.equal((await emp1.post(`/reviews/${ids.r1}/request-change`).type('form').send({ _csrf: emp1.csrf, reason: 'Please change it' })).status, 404);

    await mA.post(`/reviews/${ids.r1}/request-change`).type('form').send({ _csrf: mA.csrf, reason: 'Forgot the Q4 project', back: 'team' });
    const reqs = (await pool.query("SELECT id, reason FROM change_requests WHERE status = 'open'")).rows;
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].reason, 'Forgot the Q4 project');
    assert.deepEqual(await emails('change_requested'), [E('hr')]);
    await mA.post(`/reviews/${ids.r1}/request-change`).type('form').send({ _csrf: mA.csrf, reason: 'Again' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM change_requests')).rows[0].n, 1, 'one open request at a time');

    const team = await mA.get('/team');
    assert.match(team.text, /waiting for HR/);

    const hr = await as('hr');
    assert.match((await hr.get('/hr/requests')).text, /Forgot the Q4 project/);
    assert.equal((await mA.get('/hr/requests')).status, 403);
    await hr.post(`/hr/requests/${reqs[0].id}/decide`).type('form').send({ _csrf: hr.csrf, decision: 'approve', note: 'Go ahead' });
    assert.equal(await status(ids.r1), 'draft');
    assert.deepEqual(await emails('change_decided'), [E('mA')]);
    assert.deepEqual(await emails('review_reopened'), [E('headEng')], 'second level told; the requester already got the decision');

    const headEng = await as('headEng');
    assert.equal((await postReview(headEng, ids.r1, { action: 'save', ...allRatings(3), 'rating[speed]': '4' })).status, 302);
    assert.equal(await rating(ids.r1, 'speed'), 4, 'second level can edit after HR reopens');
    assert.equal((await postReview(headEng, ids.r1, { action: 'submit', ...allRatings(3) })).status, 302);
    assert.equal(await status(ids.r1), 'draft', 'second level cannot confirm before the manager resubmits');
    assert.equal((await postReview(mA, ids.r1, { action: 'submit', ...allRatings(3), 'rating[speed]': '4' })).status, 302);
    assert.equal(await status(ids.r1), 'submitted');
    assert.equal((await postReview(headEng, ids.r1, { action: 'submit', ...allRatings(3), 'rating[speed]': '4' })).status, 302);
    assert.equal(await status(ids.r1), 'closed');

    // A declined request leaves the review closed.
    await headEng.post(`/reviews/${ids.r1}/request-change`).type('form').send({ _csrf: headEng.csrf, reason: 'Second level wants a change' });
    const q2 = (await pool.query("SELECT id FROM change_requests WHERE status = 'open'")).rows[0].id;
    await hr.post(`/hr/requests/${q2}/decide`).type('form').send({ _csrf: hr.csrf, decision: 'decline', note: 'Not needed' });
    assert.equal(await status(ids.r1), 'closed');
  });

  test('HR reopens straight from the cycle page', async () => {
    const hr = await as('hr');
    const page = await hr.get(`/cycles/${ids.c1}`);
    assert.match(page.text, new RegExp(`action="/hr/reviews/${ids.r1}/reopen"`), 'reopen button in the organisation view');
    const res = await hr.post(`/hr/reviews/${ids.r1}/reopen`).type('form').send({ _csrf: hr.csrf, back: 'cycle' });
    assert.equal(res.headers.location, `/cycles/${ids.c1}`);
    assert.equal(await status(ids.r1), 'draft');
    const mA = await as('mA');
    await postReview(mA, ids.r1, { action: 'submit', ...allRatings(3), 'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE' });
    const headEng = await as('headEng');
    await postReview(headEng, ids.r1, { action: 'submit', ...allRatings(3), 'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE' });
    assert.equal(await status(ids.r1), 'closed');
  });

  test('organisation trees: HR starts from the heads; a head sees only their own branch', async () => {
    const hr = await as('hr');
    const tree = await hr.get(`/cycles/${ids.c1}?view=tree`);
    assert.match(tree.text, /headEng[\s\S]*not reviewed in this cycle/);
    assert.match(tree.text, /2 direct reports · 5 in total/);
    const headEng = await as('headEng');
    const team = await headEng.get('/team');
    assert.match(team.text, /mA/);
    assert.match(team.text, /emp3/);
    assert.doesNotMatch(team.text, /emp4/, 'other branch not shown');
    const headOps = await as('headOps');
    const opsTeam = await headOps.get('/team');
    assert.doesNotMatch(opsTeam.text, /emp1/);
    assert.equal((await headOps.get(`/reviews/${ids.r1}`)).status, 404);
  });

  test('CEO reads and edits every review (logged) without submitting or changing its step', async () => {
    const ceo = await as('ceo');
    const res = await ceo.get(`/reviews/${ids.r1}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /SECRET-SALARY-NOTE/);
    assert.match(res.text, /name="rating\[/, 'CEO gets the edit form');
    assert.doesNotMatch(res.text, /value="submit"/, 'but no submit or confirm button');
    const before = await status(ids.r1);
    const post = await postReview(ceo, ids.r1, { action: 'submit', ...allRatings(3), 'rating[impact]': '4' });
    assert.equal(post.status, 302);
    assert.equal(await rating(ids.r1, 'impact'), 4);
    assert.equal(await status(ids.r1), before, 'the CEO\'s edit does not change the step');
    const log = (await pool.query(
      'SELECT l.field, u.email FROM change_log l JOIN users u ON u.id = l.user_id WHERE l.review_id = $1', [ids.r1])).rows;
    assert.ok(log.some((l) => /^Impact: rating .+ → 4 · /.test(l.field) && l.email === E('ceo')), JSON.stringify(log));
    assert.equal((await ceo.get('/hr')).status, 403);
    const reopen = await ceo.post(`/hr/reviews/${ids.r1}/reopen`).type('form').send({ _csrf: ceo.csrf });
    assert.equal(reopen.status, 403, 'reopening stays with HR');
  });

  test('HR edits a completed review and the change is logged for the manager', async () => {
    const hr = await as('hr');
    const res = await postReview(hr, ids.r1, { action: 'submit', ...allRatings(3), 'rating[quality]': '5',
      'feedback[impact]': 'Visible feedback text', action_plan: 'Visible plan text', hr_action_points: 'SECRET-SALARY-NOTE',
    });
    assert.equal(res.status, 302);
    const log = (await pool.query('SELECT field, old_value, new_value FROM change_log WHERE review_id = $1 ORDER BY id', [ids.r1])).rows;
    assert.ok(log.some((l) => /^Quality: rating 3 · .+ → 5 · /.test(l.field)), JSON.stringify(log));
    assert.equal(await status(ids.r1), 'closed', 'HR does not submit on anyone\'s behalf');
    const mA = await as('mA');
    assert.match((await mA.get(`/reviews/${ids.r1}`)).text, /Quality: rating/);
  });

  test('release needs every review completed; then employees see theirs without HR points', async () => {
    const hr = await as('hr');
    await hr.post(`/hr/cycles/${ids.c1}/release`).type('form').send({ _csrf: hr.csrf, confirm: 'yes' });
    assert.equal((await pool.query('SELECT status FROM cycles WHERE id = $1', [ids.c1])).rows[0].status, 'open');

    for (const [mgr, emp, second] of [['mA', 'emp2', 'headEng'], ['mB', 'emp3', 'headEng'], ['mC', 'emp4', 'headOps'], ['headEng', 'mB'], ['headOps', 'mC']]) {
      const id = await reviewId(ids.c1, emp);
      const r = await postReview(await as(mgr), id, { action: 'submit', ...allRatings(3), hr_action_points: 'SECRET-SALARY-NOTE' });
      assert.equal(r.status, 302);
      if (second) {
        await hr.post(`/hr/cycles/${ids.c1}/release`).type('form').send({ _csrf: hr.csrf, confirm: 'yes' });
        assert.equal((await pool.query('SELECT status FROM cycles WHERE id = $1', [ids.c1])).rows[0].status, 'open', 'not before confirmation');
        assert.equal((await postReview(await as(second), id, { action: 'submit', ...allRatings(3), hr_action_points: 'SECRET-SALARY-NOTE' })).status, 302);
      }
      assert.equal(await status(id), 'closed');
    }
    await hr.post(`/hr/cycles/${ids.c1}/release`).type('form').send({ _csrf: hr.csrf, confirm: 'yes' });
    assert.equal((await pool.query('SELECT status FROM cycles WHERE id = $1', [ids.c1])).rows[0].status, 'released');
    assert.equal((await emails('cycle_released')).length, 7, 'every employee told');
    assert.ok((await pool.query("SELECT 1 FROM email_outbox WHERE body LIKE '%SECRET-SALARY-NOTE%'")).rows.length === 0, 'emails never contain review content');

    const emp1 = await as('emp1');
    const own = await emp1.get(`/reviews/${ids.r1}`);
    assert.equal(own.status, 200);
    assert.match(own.text, /Visible feedback text/);
    assert.match(own.text, /Visible plan text/);
    assert.doesNotMatch(own.text, /SECRET-SALARY-NOTE/);
    assert.doesNotMatch(own.text, /Change log/);
    assert.equal((await emp1.get(`/reviews/${ids.r3}`)).status, 404, 'not a colleague\'s review');

    const read = await emp1.post(`/reviews/${ids.r1}/read`).type('form').send({ _csrf: emp1.csrf, employee_comment: 'Thanks' });
    assert.equal(read.status, 302);
    const row = (await pool.query('SELECT employee_read_at, employee_comment FROM reviews WHERE id = $1', [ids.r1])).rows[0];
    assert.ok(row.employee_read_at);
    assert.equal(row.employee_comment, 'Thanks');

    const mA = await as('mA');
    const locked = await postReview(mA, ids.r1, { action: 'save', ...allRatings(1) });
    assert.equal(locked.status, 302);
    const rating = (await pool.query("SELECT rating FROM review_dimensions WHERE review_id = $1 AND dimension = 'impact'", [ids.r1])).rows[0].rating;
    assert.equal(rating, 3, 'no edits after release');
  });

  test('a new manager can read earlier reviews of their report, without HR points', async () => {
    const c2 = await makeCycle('C2', [['emp1', 'Eng', 'mB']]);
    await initiateCycle(c2);
    const mB = await as('mB');
    const res = await mB.get(`/reviews/${ids.r1}`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /SECRET-SALARY-NOTE/);
    assert.doesNotMatch(res.text, /name="rating\[/);
    const mC = await as('mC');
    assert.equal((await mC.get(`/reviews/${ids.r1}`)).status, 404);
  });

  test('reviews in a cycle that is still being set up are hidden from managers', async () => {
    const c3 = await makeCycle('C3', [['emp2', 'Eng', 'mC']]);
    const id = await reviewId(c3, 'emp2');
    const mC = await as('mC');
    assert.equal((await mC.get(`/reviews/${id}`)).status, 404);
    const hr = await as('hr');
    assert.equal((await hr.get(`/reviews/${id}`)).status, 200);
  });

  test('roster upload: problems are shown and nothing is saved; a clean file is saved', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const { buildTemplate } = await import('../src/template.js');
    async function file(rows) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await buildTemplate(['Problem Solving', 'Procurement', 'Project Management']));
      const emp = wb.getWorksheet('Employees');
      rows.forEach((r) => emp.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    }
    const hr = await as('hr');
    await hr.post('/hr/cycles').type('form').send({ _csrf: hr.csrf, name: 'Upload test', deadline: '2027-01-06' });
    const cycleId = (await pool.query("SELECT id FROM cycles WHERE name = 'Upload test'")).rows[0].id;

    const bad = await file(
      [['Ann One', 'ann@t.test', 'Eng', 'Engineer', 'Medium', 'Bob Boss', 'bob@t.test', 'Problem Solving', 'Procurement', 'Problem Solving'],
        ['Bob Boss', 'bob@t.test', 'Eng', 'Lead', 'Lead', 'Bob Boss', 'bob@t.test', 'Problem Solving', 'Procurement', 'Brand New Skill'],
        ['Cy Loop', 'cy@t.test', 'Eng', 'Lead', 'Lead', 'Di Loop', 'di@t.test', 'Problem Solving', 'Procurement', 'Project Management'],
        ['Di Loop', 'di@t.test', 'Eng', 'Lead', 'Lead', 'Cy Loop', 'cy@t.test', 'Problem Solving', 'Procurement', 'Project Management']],
    );
    const r1 = await hr.post(`/hr/cycles/${cycleId}/roster`).field('_csrf', hr.csrf).attach('file', bad, 'bad.xlsx');
    assert.equal(r1.status, 422);
    assert.match(r1.text, /Seniority must be one of/);
    assert.match(r1.text, /same skill is listed twice/);
    assert.match(r1.text, /cannot be their own manager/);
    assert.match(r1.text, /go round in a circle/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reviews WHERE cycle_id = $1', [cycleId])).rows[0].n, 0);

    const noToken = await hr.post(`/hr/cycles/${cycleId}/roster`).attach('file', bad, 'bad.xlsx');
    assert.equal(noToken.status, 403);

    const good = await file(
      [['Ann One', 'Ann@T.test', 'Eng', 'Engineer', 'mid', 'Bob Boss', 'bob@t.test', 'problem solving', 'Procurement', 'Brand New Skill']],
    );
    const r2 = await hr.post(`/hr/cycles/${cycleId}/roster`).field('_csrf', hr.csrf).attach('file', good, 'good.xlsx');
    assert.equal(r2.status, 302);
    const saved = (await pool.query(
      `SELECT u.email, r.seniority, s.name AS skill1 FROM reviews r JOIN users u ON u.id = r.employee_id JOIN skills s ON s.id = r.skill1_id WHERE r.cycle_id = $1`,
      [cycleId],
    )).rows;
    assert.deepEqual(saved, [{ email: 'ann@t.test', seniority: 'Mid', skill1: 'Problem Solving' }]);
    assert.ok((await pool.query("SELECT 1 FROM skills WHERE name = 'Brand New Skill'")).rows.length, 'new skill added');
    const setup = await hr.get(`/hr/cycles/${cycleId}/setup`);
    assert.match(setup.text, /Bob Boss[\s\S]*not reviewed in this cycle/, 'organisation preview starts from the manager');
  });

  test('bad ids give 404 and do not crash the server', async () => {
    const emp1 = await as('emp1');
    assert.equal((await emp1.get('/reviews/99999999999')).status, 404);
    assert.equal((await emp1.get('/reviews/abc')).status, 404);
    const hr = await as('hr');
    assert.equal((await hr.get('/cycles/abc')).status, 404);
    assert.equal((await hr.get('/hr/cycles/99999999999/setup')).status, 404);
    assert.equal((await hr.get('/dashboard')).status, 302, 'still running');
  });

  test('own review stays private for HR admins and managers; CEO can write reviews they own', async () => {
    await pool.query("INSERT INTO users (email, name, global_role) VALUES ($1, 'hr2', 'hr_admin')", [E('hr2')]);
    const c4 = await makeCycle('C4', [['hr2', 'HR', 'ceo'], ['headSales', 'Sales', 'ceo'], ['mD', 'Sales', 'headSales'], ['emp5', 'Sales', 'mD']]);
    await initiateCycle(c4);
    const own = await reviewId(c4, 'hr2');
    const headOwn = await reviewId(c4, 'headSales');
    const emp5 = await reviewId(c4, 'emp5');

    const ceo = await as('ceo');
    const write = await postReview(ceo, own, { action: 'submit', ...allRatings(3), hr_action_points: 'HR2-PROMOTION-NOTE' });
    assert.equal(write.status, 302, 'CEO as reviewer can submit');
    assert.equal(await status(own), 'closed', 'no second level above the CEO');
    await postReview(ceo, headOwn, { action: 'submit', ...allRatings(4) });

    const hr2 = await as('hr2');
    assert.equal((await hr2.get(`/reviews/${own}`)).status, 404, 'HR admin cannot open own review before release');
    assert.equal((await postReview(hr2, own, { action: 'save', ...allRatings(5) })).status, 404);
    const overview = await hr2.get(`/cycles/${c4}`);
    assert.doesNotMatch(overview.text, new RegExp(`href="/reviews/${own}"`));
    assert.equal((await hr2.get(`/reviews/${emp5}`)).status, 200, 'but sees others');

    const headSales = await as('headSales');
    const team = await headSales.get('/team');
    assert.doesNotMatch(team.text, new RegExp(`href="/reviews/${headOwn}"`));
    assert.match(team.text, /emp5/, 'sees their branch');
    assert.match(team.text, /You can open it once mD submits/);
    assert.equal((await headSales.get(`/reviews/${headOwn}`)).status, 404);

    // Stale form: HR saves after the manager opened the form; the manager's old form is refused.
    const mD = await as('mD');
    const stale = await ver(mD, emp5);
    const hr = await as('hr');
    assert.equal((await postReview(hr, emp5, { action: 'save', ...allRatings(4), 'chk[impact][POOR][0]': 'no' })).status, 302);
    const conflict = await mD.post(`/reviews/${emp5}`).type('form').send({ _csrf: mD.csrf, version: stale, action: 'save', ...allRatings(2) });
    assert.equal(conflict.status, 409);
    const impact = (await pool.query("SELECT rating FROM review_dimensions WHERE review_id = $1 AND dimension = 'impact'", [emp5])).rows[0].rating;
    assert.equal(impact, 4, 'HR change kept');
    const log = (await pool.query('SELECT field, details FROM change_log WHERE review_id = $1', [emp5])).rows;
    const impactLog = log.filter((l) => l.field.startsWith('Impact: '));
    assert.equal(impactLog.length, 1, `one entry for the dimension, rating and checklist together: ${JSON.stringify(log)}`);
    assert.match(impactLog[0].details, /^“.+” not answered → No$/, 'says which statement changed');

    // A multipart post without a token is refused (only the roster upload is multipart).
    const mp = await mD.post(`/reviews/${emp5}`).field('action', 'save');
    assert.equal(mp.status, 403);
  });

  test('CEO is never the second level: a head\'s submit completes the review; the CEO may still edit it', async () => {
    const c5 = await makeCycle('C5', [['headX', 'X', 'ceo'], ['mX', 'X', 'headX'], ['empX', 'X', 'mX']]);
    await initiateCycle(c5);
    const rmX = await reviewId(c5, 'mX');
    const rHead = await reviewId(c5, 'headX');
    const headX = await as('headX');
    assert.match((await headX.get(`/reviews/${rmX}`)).text, /Submitting completes the review/);
    assert.equal((await postReview(headX, rmX, { action: 'submit', ...allRatings(3) })).status, 302);
    assert.equal(await status(rmX), 'closed', 'no CEO confirmation step');
    const ceo = await as('ceo');
    const home = await ceo.get('/team');
    assert.doesNotMatch(home.text, /Review and confirm|To confirm/, 'nothing waits for the CEO');
    assert.equal((await postReview(ceo, rmX, { action: 'save', ...allRatings(4) })).status, 302);
    assert.equal(await status(rmX), 'closed');
    assert.equal(await rating(rmX, 'impact'), 4);
    // The CEO writes and submits the heads' reviews; they complete straight away.
    assert.equal((await postReview(ceo, rHead, { action: 'submit', ...allRatings(3) })).status, 302);
    assert.equal(await status(rHead), 'closed');
    // ...and can still edit them afterwards as CEO.
    assert.equal((await postReview(ceo, rHead, { action: 'save', ...allRatings(5) })).status, 302);
    assert.equal(await rating(rHead, 'impact'), 5);
  });

  test('discussion next to a review: everyone involved, never the employee, read-only after release', async () => {
    const c6 = await makeCycle('C6', [['headY', 'Y', 'ceo'], ['mY', 'Y', 'headY'], ['empY', 'Y', 'mY']]);
    await initiateCycle(c6);
    const id = await reviewId(c6, 'empY');
    const mY = await as('mY');
    const headY = await as('headY');
    const hr = await as('hr');
    const ceo = await as('ceo');
    const say = (agent, body) => agent.post(`/reviews/${id}/comments`).type('form').send({ _csrf: agent.csrf, body });
    assert.equal((await say(mY, 'MANAGER-NOTE before submit')).status, 302);
    assert.equal((await say(headY, 'too early')).status, 404, 'second level not involved before the submit');
    assert.equal((await say(await as('empY'), 'employee')).status, 404);
    assert.equal((await say(await as('emp1'), 'stranger')).status, 404);
    assert.match((await hr.get(`/reviews/${id}`)).text, /MANAGER-NOTE before submit/);
    assert.equal((await say(ceo, 'CEO-NOTE')).status, 302);

    assert.equal((await postReview(mY, id, { action: 'submit', ...allRatings(3) })).status, 302);
    assert.equal(await status(id), 'submitted', 'headY confirms (their own manager is the CEO, but they are not)');
    assert.match((await headY.get('/team')).text, /\d+ new/, 'second level sees new activity');
    const page = await headY.get(`/reviews/${id}`);
    assert.match(page.text, /MANAGER-NOTE before submit/);
    assert.match(page.text, /CEO-NOTE/);
    assert.doesNotMatch((await headY.get('/team')).text, /\d+ new/, 'seen after opening it');

    // The second level changes a rating; the manager sees the latest version and the change, and can reply.
    assert.equal((await postReview(headY, id, { action: 'save', ...allRatings(3), 'rating[quality]': '1' })).status, 302);
    assert.match((await mY.get('/team')).text, /\d+ new/);
    const mine = await mY.get(`/reviews/${id}`);
    assert.match(mine.text, /Quality: rating/);
    assert.match(mine.text, /Rating:<\/span> <span class="rating-read">[^<]*\(1\)/, 'manager sees the updated version');
    assert.equal((await say(mY, 'I disagree on Ownership')).status, 302, 'manager can still comment after submitting');
    assert.equal((await say(mY, '   ')).status, 302);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM review_comments WHERE review_id = $1', [id])).rows[0].n, 3, 'empty message ignored');
    // Posted in the background from the review page (keeps unsaved form changes): JSON, no reload.
    const bg = (agent, body) => agent.post(`/reviews/${id}/comments`).set('X-Requested-With', 'fetch').type('form').send({ _csrf: agent.csrf, body });
    const ok = await bg(mY, 'BACKGROUND-NOTE <b>');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.comment.body, 'BACKGROUND-NOTE <b>');
    assert.ok(ok.body.comment.user_name && ok.body.comment.atLabel);
    assert.equal((await bg(mY, '  ')).body.ok, false, 'empty message refused');
    assert.equal((await bg(await as('emp1'), 'stranger')).status, 404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM review_comments WHERE review_id = $1', [id])).rows[0].n, 4);

    // Released cycle: discussion is read-only and never shown to the employee.
    assert.equal((await postReview(headY, id, { action: 'submit', ...allRatings(3) })).status, 302);
    await hr.post(`/hr/cycles/${c6}/release`).type('form').send({ _csrf: hr.csrf, confirm: 'yes' });
    assert.equal((await pool.query('SELECT status FROM cycles WHERE id = $1', [c6])).rows[0].status, 'open', 'headY review by the CEO not done yet');
    const rHead = await reviewId(c6, 'headY');
    await postReview(ceo, rHead, { action: 'submit', ...allRatings(3) });
    const rM = await reviewId(c6, 'mY');
    await postReview(headY, rM, { action: 'submit', ...allRatings(3) });
    await hr.post(`/hr/cycles/${c6}/release`).type('form').send({ _csrf: hr.csrf, confirm: 'yes' });
    assert.equal((await pool.query('SELECT status FROM cycles WHERE id = $1', [c6])).rows[0].status, 'released');
    const after = await mY.get(`/reviews/${id}`);
    assert.match(after.text, /I disagree on Ownership/);
    assert.doesNotMatch(after.text, /name="body"/, 'no message box after release');
    await say(mY, 'LATE');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM review_comments WHERE body = 'LATE'")).rows[0].n, 0);
    const emp = await (await as('empY')).get(`/reviews/${id}`);
    assert.equal(emp.status, 200);
    assert.doesNotMatch(emp.text, /MANAGER-NOTE|CEO-NOTE|Discussion and changes/);
  });

  test('making someone CEO completes the reviews that were waiting for them to confirm', async () => {
    const c7 = await makeCycle('C7', [['mZ', 'Z', 'bossZ'], ['empZ', 'Z', 'mZ']]);
    await initiateCycle(c7);
    const id = await reviewId(c7, 'empZ');
    await postReview(await as('mZ'), id, { action: 'submit', ...allRatings(3) });
    assert.equal(await status(id), 'submitted');
    const hr = await as('hr');
    const res = await hr.post('/hr/settings/role').type('form').send({ _csrf: hr.csrf, email: E('bossZ'), name: 'bossZ', role: 'viewer_all' });
    assert.equal(res.status, 302);
    assert.equal(await status(id), 'closed');
    await hr.post('/hr/settings/role').type('form').send({ _csrf: hr.csrf, email: E('bossZ'), role: '' });
  });

  test('navigation and dashboard: HR lands on the dashboard; managers keep Home; the CEO has no HR admin', async () => {
    const hr = await as('hr');
    assert.equal((await hr.get('/')).headers.location, '/dashboard');
    const dash = await hr.get('/dashboard');
    assert.match(dash.headers.location, /^\/cycles\/\d+$/);
    const page = await hr.get(dash.headers.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /HR dashboard/);
    assert.match(page.text, /HR admin/);
    assert.match(page.text, /data-row/, 'reviews table is the default view');
    assert.match((await hr.get('/hr/settings')).text, /class="subtabs"/);
    const ceo = await as('ceo');
    const ceoPage = await ceo.get((await ceo.get('/dashboard')).headers.location);
    assert.match(ceoPage.text, />Dashboard</);
    assert.doesNotMatch(ceoPage.text, /HR admin|Release all reviews|Add a late joiner/);
    const mA = await as('mA');
    assert.equal((await mA.get('/')).status, 200);
    assert.equal((await mA.get('/dashboard')).status, 302);
    assert.doesNotMatch((await mA.get('/me')).text, /HR dashboard|HR admin/);
  });

  test('only HR opens HR pages', async () => {
    for (const who of ['mA', 'emp1', 'headEng', 'ceo']) {
      const agent = await as(who);
      assert.equal((await agent.get('/hr')).status, 403);
      if (who !== 'ceo') assert.equal((await agent.get(`/cycles/${ids.c1}`)).status, 404);
      const post = await agent.post('/hr/cycles').type('form').send({ _csrf: agent.csrf, name: 'Hack' });
      assert.equal(post.status, 403);
    }
  });

  test('skills from Notion: HR checks, then applies; running cycles keep their questionnaire', async () => {
    const { config } = await import('../src/config.js');
    const { readSkillBase, planSkillSync, applySkillSync } = await import('../src/notion.js');
    const { getReviewDetail } = await import('../src/reviews.js');
    config.notion.token = 'test-token';
    const ps = (await pool.query("SELECT notion_page_id FROM skills WHERE name = 'Problem Solving'")).rows[0];
    assert.ok(ps.notion_page_id, 'seeded skills know their Notion page');

    const c8 = await makeCycle('C8', [['empN', 'N', 'mN']]);
    await initiateCycle(c8);
    const before = await getReviewDetail(await reviewId(c8, 'empN'));
    const oldBasic = before.dimensions.find((d) => d.label === 'Problem Solving').statements.BASIC;

    // A fake Notion: Problem Solving reworded, one new draft skill, one broken page.
    const rt = (t) => [{ plain_text: t }];
    const row = (level, text) => ({ type: 'table_row', table_row: { cells: [rt(level), rt(text)] } });
    const page = (id, title) => ({ object: 'page', id, url: `https://notion.so/${id}`, last_edited_time: '2026-11-20T10:00:00.000Z', properties: { Skill: { type: 'title', title: rt(title) } } });
    const pages = [page(ps.notion_page_id, 'Problem Solving'), page('11111111111111111111111111111111', 'DRAFT Safety Culture'), page('22222222222222222222222222222222', 'Empty Skill')];
    const blocks = {
      [ps.notion_page_id]: [
        { type: 'heading_3', heading_3: { rich_text: rt('Definition') } },
        { type: 'callout', callout: { rich_text: rt('Breaks problems down into their drivers.') } },
        { type: 'table', id: 'tps', has_children: true, table: { has_column_header: true } },
      ],
      tps: [row('Level', 'Behavior'), row('POOR', 'Jumps to conclusions'), row('BASIC', 'Breaks down simple problems'), row('', 'Uses data   to check'), row('ADVANCED', 'Connects issues across teams')],
      '11111111111111111111111111111111': [{ type: 'table', id: 'tsc', has_children: true, table: { has_column_header: false } }],
      tsc: [row('Basic', 'Follows safety rules'), row('Mastery', 'ignored')],
      '22222222222222222222222222222222': [{ type: 'paragraph', paragraph: { rich_text: rt('todo') } }],
    };
    const fakeFetch = async (url) => {
      const u = new URL(url);
      const json = (data) => ({ ok: true, status: 200, json: async () => data, headers: new Map() });
      if (u.pathname.endsWith('/query')) return json({ results: pages, has_more: false });
      const id = u.pathname.split('/')[3];
      return json({ results: blocks[id] || [], has_more: false });
    };
    const plan = await planSkillSync(await readSkillBase(fakeFetch));
    const by = (n) => plan.find((p) => (p.notion?.name || p.app?.name) === n);
    assert.equal(by('Problem Solving').kind, 'update');
    assert.deepEqual(by('Problem Solving').notion.levels.BASIC, ['Breaks down simple problems', 'Uses data to check'], 'a row without level joins the level above; spaces cleaned');
    assert.equal(by('Safety Culture').kind, 'new');
    assert.equal(by('Safety Culture').notion.draft, true);
    assert.ok(by('Safety Culture').warnings.some((w) => /unknown level/.test(w)));
    assert.equal(by('Empty Skill').kind, 'problem', 'a page without statements is never applied');
    assert.equal(by('Procurement').kind, 'missing', 'skills not in this Notion list are kept, not deleted');

    // HR flow: check page, then apply.
    const hr = await as('hr');
    assert.match((await hr.get('/hr')).text, /Check Notion for changes/);
    assert.equal(await applySkillSync(plan), 2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM skills WHERE name = 'Empty Skill'")).rows[0].n, 0);
    const after = await getReviewDetail(await reviewId(c8, 'empN'));
    assert.deepEqual(after.dimensions.find((d) => d.label === 'Problem Solving').statements.BASIC, oldBasic, 'running cycle keeps its questionnaire');
    const c9 = await makeCycle('C9', [['empN', 'N', 'mN']]);
    await initiateCycle(c9);
    const fresh = await getReviewDetail(await reviewId(c9, 'empN'));
    assert.deepEqual(fresh.dimensions.find((d) => d.label === 'Problem Solving').statements.BASIC, ['Breaks down simple problems', 'Uses data to check'], 'a new cycle gets the update');
    assert.equal(fresh.dimensions.find((d) => d.label === 'Problem Solving').intro, 'Breaks problems down into their drivers.');
    // The seed on the next start does not bring back or duplicate anything.
    await migrate({ quiet: true });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM skills WHERE name = 'Problem Solving'")).rows[0].n, 1);
    config.notion.token = '';
  });

  test('set-up page: the Excel template is locked until skills are synced with Notion', async () => {
    const { config } = await import('../src/config.js');
    const hr = await as('hr');
    const cid = (await pool.query("INSERT INTO cycles (name, talent_bar) VALUES ('C10 setup', $1) RETURNING id", [JSON.stringify(TALENT_BAR)])).rows[0].id;
    const page = async () => (await hr.get(`/hr/cycles/${cid}/setup`)).text;
    await pool.query("DELETE FROM app_settings WHERE key = 'notion_skills'");
    // Not connected to Notion: nothing to sync, the template stays available, with a clear notice.
    config.notion.token = '';
    let html = await page();
    assert.match(html, /Sync the skills with Notion/);
    assert.match(html, /not connected to Notion yet/);
    assert.match(html, /href="\/hr\/template\.xlsx"/);
    // Connected but never synced: locked, and the source-of-truth guidance is shown.
    config.notion.token = 'test-token';
    html = await page();
    assert.match(html, /Notion is the source of truth/);
    assert.match(html, /Sync before you continue/);
    assert.doesNotMatch(html, /href="\/hr\/template\.xlsx"/);
    assert.match(html, /href="\/hr\/skills\/notion\?cycle=\d+"/);
    // A sync recorded after the cycle was created unlocks it.
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('notion_skills', $1)", [JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), by: 'Daria', changed: 0 })]);
    html = await page();
    assert.match(html, /Skills are synced/);
    assert.match(html, /href="\/hr\/template\.xlsx"/);
    // A sync older than the cycle does not count.
    await pool.query("UPDATE app_settings SET value = $1 WHERE key = 'notion_skills'", [JSON.stringify({ at: '2020-01-01T00:00:00.000Z', by: 'Daria', changed: 0 })]);
    assert.doesNotMatch(await page(), /href="\/hr\/template\.xlsx"/);
    config.notion.token = '';
  });

  test('HR can cancel an initiated cycle for good, only by typing its name; managers cannot', async () => {
    const hr = await as('hr');
    const cid = await makeCycle('C11 cancel', [['empZ', 'Z', 'mZ']]);
    await initiateCycle(cid);
    const rid = await reviewId(cid, 'empZ');
    const post = (agent, id, body) => agent.post(`/hr/cycles/${id}/cancel`).type('form').send({ _csrf: agent.csrf, ...body });
    const exists = async () => (await pool.query('SELECT count(*)::int AS n FROM cycles WHERE id = $1', [cid])).rows[0].n;
    assert.doesNotMatch((await hr.get(`/cycles/${cid}`)).text, /\/cancel"|Cancel cycle|for good/, 'the dashboard is only a view on the cycle');
    assert.match((await hr.get('/hr')).text, new RegExp(`action="/hr/cycles/${cid}/cancel"`), 'cancelling is in HR admin');
    // A manager is refused.
    const mgr = await as('mZ');
    assert.equal((await post(mgr, cid, { confirmName: 'C11 cancel' })).status, 403);
    assert.equal(await exists(), 1);
    // Wrong name: nothing happens.
    assert.equal((await post(hr, cid, { confirmName: 'something else' })).status, 302);
    assert.equal(await exists(), 1);
    // Right name: the cycle and everything under it is gone; the people stay.
    const res = await post(hr, cid, { confirmName: ' c11 CANCEL ' });
    assert.equal(res.status, 302);
    assert.equal(await exists(), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reviews WHERE id = $1', [rid])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [E('empZ')])).rows[0].n, 1);
    // Not for cycles still being set up (those have their own Delete).
    const setupId = (await pool.query("INSERT INTO cycles (name, talent_bar) VALUES ('C12 setup', $1) RETURNING id", [JSON.stringify(TALENT_BAR)])).rows[0].id;
    await post(hr, setupId, { confirmName: 'C12 setup' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cycles WHERE id = $1', [setupId])).rows[0].n, 1);
  });
}
