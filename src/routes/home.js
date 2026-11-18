import express from 'express';
import { one, many } from '../db.js';
import { listReviews, STATUS_LABELS } from '../reviews.js';
import { seesEverything, parseId } from '../access.js';
import { cycleSummary } from '../cycles.js';

function groupByCycle(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.cycle_id)) {
      groups.set(r.cycle_id, { id: r.cycle_id, name: r.cycle_name, status: r.cycle_status, deadline: r.deadline, reviews: [] });
    }
    groups.get(r.cycle_id).reviews.push(r);
  }
  return [...groups.values()];
}

export function homeRoutes() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const me = req.user;
    const [mine, team, heads, cycles] = await Promise.all([
      many(`SELECT r.id, c.name AS cycle_name, r.employee_read_at FROM reviews r JOIN cycles c ON c.id = r.cycle_id
             WHERE r.employee_id = $1 AND c.status = 'released' ORDER BY c.released_at DESC`, [me.id]),
      many(`SELECT r.status, c.id AS cycle_id, c.name AS cycle_name, c.status AS cycle_status, c.deadline
              FROM reviews r JOIN cycles c ON c.id = r.cycle_id
             WHERE r.reviewer_id = $1 AND c.status = 'open'`, [me.id]),
      many(`SELECT d.name, c.name AS cycle_name FROM cycle_departments d JOIN cycles c ON c.id = d.cycle_id
             WHERE d.head_user_id = $1 AND c.status <> 'setup' ORDER BY c.created_at DESC`, [me.id]),
      seesEverything(me) ? many('SELECT * FROM cycles ORDER BY created_at DESC') : [],
    ]);
    const openTeam = groupByCycle(team.map((t) => ({ ...t })));
    for (const g of openTeam) {
      g.todo = g.reviews.filter((r) => r.status !== 'submitted').length;
      g.total = g.reviews.length;
    }
    const hasTeamHistory = !!(await one('SELECT 1 FROM reviews r JOIN cycles c ON c.id = r.cycle_id WHERE r.reviewer_id = $1 AND c.status <> \'setup\' LIMIT 1', [me.id]));
    res.render('home', { title: 'Home', mine, openTeam, hasTeamHistory, heads, cycles });
  });

  router.get('/me', async (req, res) => {
    const rows = await listReviews("r.employee_id = $1 AND c.status = 'released'", [req.user.id]);
    res.render('me', { title: 'My reviews', rows });
  });

  router.get('/team', async (req, res) => {
    const rows = await listReviews("r.reviewer_id = $1 AND c.status <> 'setup'", [req.user.id]);
    const groups = groupByCycle(rows);
    // Earlier reviews of people the user manages now (read-only, released cycles only).
    const earlier = await many(
      `SELECT DISTINCT old.id, e.name AS employee_name, oc.name AS cycle_name, oc.created_at
         FROM reviews cur
         JOIN cycles cc ON cc.id = cur.cycle_id AND cc.status <> 'setup'
         JOIN reviews old ON old.employee_id = cur.employee_id AND old.cycle_id < cur.cycle_id
         JOIN cycles oc ON oc.id = old.cycle_id AND oc.status = 'released'
         JOIN users e ON e.id = old.employee_id
        WHERE cur.reviewer_id = $1 AND old.reviewer_id <> $1
        ORDER BY e.name, oc.created_at DESC`,
      [req.user.id],
    );
    res.render('team', { title: 'My team', groups, earlier, STATUS_LABELS });
  });

  router.get('/department', async (req, res) => {
    const depts = await many(
      `SELECT d.cycle_id, d.name FROM cycle_departments d JOIN cycles c ON c.id = d.cycle_id
        WHERE d.head_user_id = $1 AND c.status <> 'setup'`,
      [req.user.id],
    );
    let rows = [];
    if (depts.length) {
      const pairs = depts.map((d, i) => `(r.cycle_id = $${i * 2 + 1} AND r.department = $${i * 2 + 2})`).join(' OR ');
      // A head never sees their own review here (they get it under My reviews after release).
      rows = await listReviews(`(${pairs}) AND r.employee_id <> $${depts.length * 2 + 1}`, [...depts.flatMap((d) => [d.cycle_id, d.name]), req.user.id]);
    }
    res.render('department', { title: 'My department', groups: groupByCycle(rows), STATUS_LABELS });
  });

  // Cycle overview for HR and the CEO.
  router.get('/cycles/:id', async (req, res) => {
    const cycleId = parseId(req.params.id);
    if (!seesEverything(req.user) || !cycleId) return res.status(404).render('error', { title: 'Not found', message: "This page doesn't exist." });
    const summary = await cycleSummary(cycleId);
    if (!summary) return res.status(404).render('error', { title: 'Not found', message: "This cycle doesn't exist." });
    if (summary.cycle.status === 'setup') {
      if (req.user.global_role === 'hr_admin') return res.redirect(`/hr/cycles/${summary.cycle.id}/setup`);
      return res.render('error', { title: summary.cycle.name, message: 'HR is still preparing this cycle.' });
    }
    const rows = await listReviews('r.cycle_id = $1', [summary.cycle.id]);
    for (const r of rows) {
      // Your own review stays hidden until release, even for HR and the CEO.
      r.isOwnHidden = r.employee_id === req.user.id && summary.cycle.status !== 'released';
      if (r.isOwnHidden) r.grades = { overall: undefined };
    }
    const managers = new Map();
    for (const r of rows) {
      if (!managers.has(r.reviewer_id)) managers.set(r.reviewer_id, { name: r.reviewer_name, email: r.reviewer_email, total: 0, not_started: 0, draft: 0, submitted: 0 });
      const m = managers.get(r.reviewer_id);
      m.total += 1;
      m[r.status] += 1;
    }
    const skills = req.user.global_role === 'hr_admin' ? await many('SELECT id, name FROM skills ORDER BY name') : [];
    res.render('cycle', {
      title: summary.cycle.name,
      ...summary,
      rows,
      managers: [...managers.values()].sort((a, b) => (b.total - b.submitted) - (a.total - a.submitted) || a.name.localeCompare(b.name)),
      submitted: rows.filter((r) => r.status === 'submitted').length,
      STATUS_LABELS,
      skills,
      isHrUser: req.user.global_role === 'hr_admin',
    });
  });

  return router;
}
