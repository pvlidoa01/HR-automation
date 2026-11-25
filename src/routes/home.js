import express from 'express';
import { one, many } from '../db.js';
import { listReviews, attachNewActivity, teamTodo, STATUS_LABELS } from '../reviews.js';
import { seesEverything, parseId, confirmerFor } from '../access.js';
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

  // Home. HR and the CEO start on the dashboard. Everyone who writes or confirms reviews lands on
  // their team page (Home); people with no one to review go straight to their own reviews.
  router.get('/', async (req, res) => {
    if (seesEverything(req.user)) return res.redirect('/dashboard');
    if (!res.locals.nav?.team) return res.redirect('/me');
    return renderTeam(req, res);
  });

  // HR / CEO dashboard: opens the most recent open cycle (or the latest released one).
  router.get('/dashboard', async (req, res) => {
    if (!seesEverything(req.user)) return res.redirect('/');
    const cycle = await one(
      `SELECT id FROM cycles WHERE status <> 'setup'
        ORDER BY (status = 'open') DESC, created_at DESC LIMIT 1`,
    );
    if (cycle) return res.redirect(`/cycles/${cycle.id}`);
    res.render('dashboard-empty', { title: 'Dashboard', isHrUser: req.user.global_role === 'hr_admin' });
  });

  router.get('/me', async (req, res) => {
    const rows = await listReviews("r.employee_id = $1 AND c.status = 'released'", [req.user.id]);
    res.render('me', { title: 'My reviews', rows });
  });

  // My team (the same page as Home for managers; "My team" for HR and the CEO).
  router.get('/team', (req, res) => renderTeam(req, res));

  // My branch of the organisation tree, for every cycle I review in.
  async function renderTeam(req, res) {
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
      // Who confirms this person's reviews, and whose reviews they confirm, to explain only the
      // steps that apply to them. The CEO is never a second level.
      let confirmer = null;
      let confirmsFor = [];
      if (cycle.status === 'open' && req.user.global_role !== 'viewer_all') {
        const cid = await confirmerFor(cycle.id, req.user.id);
        if (cid) confirmer = (await one('SELECT name FROM users WHERE id = $1', [cid]))?.name || null;
        confirmsFor = (await many(
          `SELECT DISTINCT m.name FROM reviews r
             JOIN reviews mr ON mr.cycle_id = r.cycle_id AND mr.employee_id = r.reviewer_id
             JOIN users m ON m.id = r.reviewer_id
            WHERE r.cycle_id = $1 AND mr.reviewer_id = $2 AND r.employee_id <> $2
            ORDER BY m.name`,
          [cycle.id, req.user.id],
        )).map((r) => r.name);
      }
      groups.push({ ...cycle, roots: tree.roots, confirmer, confirmsFor });
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
    const todo = await teamTodo(req.user.id);
    const asHome = !seesEverything(req.user);
    res.render('team', { title: asHome ? 'Home' : 'My team', asHome, groups, earlier, todo, STATUS_LABELS });
  }

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
    const view = ['managers', 'tree'].includes(req.query.view) ? req.query.view : 'reviews';
    const allCycles = await many("SELECT id, name, status, deadline FROM cycles WHERE status <> 'setup' ORDER BY created_at DESC");
    const options = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const openRequests = req.user.global_role === 'hr_admin'
      ? await one("SELECT count(*)::int AS n FROM change_requests q JOIN reviews r ON r.id = q.review_id WHERE q.status = 'open' AND r.cycle_id = $1", [summary.cycle.id])
      : null;
    const skills = req.user.global_role === 'hr_admin' ? await many('SELECT id, name FROM skills ORDER BY name') : [];
    const counts = { not_started: 0, draft: 0, submitted: 0, closed: 0 };
    for (const r of rows) counts[r.status] += 1;
    res.render('dashboard', {
      title: `${summary.cycle.name} · Dashboard`,
      allCycles,
      counts,
      requestsCount: rows.filter((r) => r.open_request_id).length,
      newCount: rows.filter((r) => r.newActivity).length,
      managerOptions: options('reviewer_name'),
      departmentOptions: options('department'),
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
