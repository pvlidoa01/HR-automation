import express from 'express';
import { one, many } from '../db.js';
import { listReviews, attachNewActivity, STATUS_LABELS } from '../reviews.js';
import { seesEverything, parseId } from '../access.js';
import { cycleSummary } from '../cycles.js';
import { buildTree } from '../org.js';

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
    const [mine, team, toConfirm, requests, cycles] = await Promise.all([
      many(`SELECT r.id, c.name AS cycle_name, r.employee_read_at FROM reviews r JOIN cycles c ON c.id = r.cycle_id
             WHERE r.employee_id = $1 AND c.status = 'released' ORDER BY c.released_at DESC`, [me.id]),
      many(`SELECT r.status, c.id AS cycle_id, c.name AS cycle_name, c.status AS cycle_status, c.deadline
              FROM reviews r JOIN cycles c ON c.id = r.cycle_id
             WHERE r.reviewer_id = $1 AND c.status = 'open'`, [me.id]),
      many(`SELECT r.id, e.name AS employee_name, m.name AS reviewer_name, c.name AS cycle_name
              FROM reviews r
              JOIN reviews mr ON mr.cycle_id = r.cycle_id AND mr.employee_id = r.reviewer_id
              JOIN users me ON me.id = mr.reviewer_id AND me.global_role IS DISTINCT FROM 'viewer_all'
              JOIN cycles c ON c.id = r.cycle_id
              JOIN users e ON e.id = r.employee_id
              JOIN users m ON m.id = r.reviewer_id
             WHERE mr.reviewer_id = $1 AND r.status = 'submitted' AND c.status = 'open' AND r.employee_id <> $1
             ORDER BY r.submitted_at`, [me.id]),
      me.global_role === 'hr_admin' ? one("SELECT count(*)::int AS n FROM change_requests WHERE status = 'open'") : null,
      seesEverything(me) ? many('SELECT * FROM cycles ORDER BY created_at DESC') : [],
    ]);
    const openTeam = groupByCycle(team.map((t) => ({ ...t })));
    for (const g of openTeam) {
      g.todo = g.reviews.filter((r) => ['not_started', 'draft'].includes(r.status)).length;
      g.total = g.reviews.length;
    }
    const hasTeamHistory = !!(await one('SELECT 1 FROM reviews r JOIN cycles c ON c.id = r.cycle_id WHERE r.reviewer_id = $1 AND c.status <> \'setup\' LIMIT 1', [me.id]));
    res.render('home', { title: 'Home', mine, openTeam, hasTeamHistory, toConfirm, openRequests: requests?.n || 0, cycles });
  });

  router.get('/me', async (req, res) => {
    const rows = await listReviews("r.employee_id = $1 AND c.status = 'released'", [req.user.id]);
    res.render('me', { title: 'My reviews', rows });
  });

  // My team: my branch of the organisation tree, for every cycle I review in.
  router.get('/team', async (req, res) => {
    const cycles = await many(
      `SELECT DISTINCT c.* FROM cycles c JOIN reviews r ON r.cycle_id = c.id
        WHERE r.reviewer_id = $1 AND c.status <> 'setup' ORDER BY c.created_at DESC`,
      [req.user.id],
    );
    const groups = [];
    for (const cycle of cycles) {
      const rows = await listReviews('r.cycle_id = $1', [cycle.id]);
      const tree = buildTree(rows, req.user, cycle, { rootUserId: req.user.id });
      await attachNewActivity(req.user.id, rows, (r) => r.access?.canSeeChangeLog);
      groups.push({ ...cycle, roots: tree.roots });
    }
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
      if (!managers.has(r.reviewer_id)) managers.set(r.reviewer_id, { name: r.reviewer_name, email: r.reviewer_email, total: 0, not_started: 0, draft: 0, submitted: 0, closed: 0 });
      const m = managers.get(r.reviewer_id);
      m.total += 1;
      m[r.status] += 1;
    }
    const tree = buildTree(rows, req.user, summary.cycle);
    await attachNewActivity(req.user.id, rows, (r) => !r.isOwnHidden && r.access?.canSeeChangeLog);
    const view = req.query.view === 'list' ? 'list' : 'tree';
    const openRequests = req.user.global_role === 'hr_admin'
      ? await one("SELECT count(*)::int AS n FROM change_requests q JOIN reviews r ON r.id = q.review_id WHERE q.status = 'open' AND r.cycle_id = $1", [summary.cycle.id])
      : null;
    const skills = req.user.global_role === 'hr_admin' ? await many('SELECT id, name FROM skills ORDER BY name') : [];
    res.render('cycle', {
      title: summary.cycle.name,
      ...summary,
      rows,
      managers: [...managers.values()].sort((a, b) => (b.total - b.closed) - (a.total - a.closed) || a.name.localeCompare(b.name)),
      closed: rows.filter((r) => r.status === 'closed').length,
      waiting: rows.filter((r) => r.status === 'submitted').length,
      roots: tree.roots,
      view,
      openRequests: openRequests?.n || 0,
      STATUS_LABELS,
      skills,
      isHrUser: req.user.global_role === 'hr_admin',
    });
  });

  return router;
}
