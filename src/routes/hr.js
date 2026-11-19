import express from 'express';
import multer from 'multer';
import { one, many, query } from '../db.js';
import { requireHr, verifyCsrf } from '../auth/index.js';
import { parseId } from '../access.js';
import { flash } from '../app.js';
import { TALENT_BAR, SENIORITIES } from '../shared/framework.js';
import { parseRoster, validateRoster } from '../roster.js';
import { buildTemplate } from '../template.js';
import { listReviews, STATUS_LABELS } from '../reviews.js';
import {
  saveRoster, initiateCycle, releaseCycle, addReview, reassignReviewer,
  removeReview, reopenReview, cycleSummary, decideChange,
} from '../cycles.js';
import {
  EMAIL_KINDS, getEmailSettings, saveEmailSettings, emailSendingEnabled,
  notifyInitiated, notifyReleased, notifyReopened, notifyChangeDecided, safely,
} from '../notify.js';
import { config } from '../config.js';
import { buildTree } from '../org.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function skillNames() {
  return (await many('SELECT name FROM skills ORDER BY draft, name')).map((r) => r.name);
}

async function renderSetup(res, cycleId, extra = {}) {
  const summary = await cycleSummary(cycleId);
  if (!summary) return res.status(404).render('error', { title: 'Not found', message: "This cycle doesn't exist." });
  if (summary.cycle.status !== 'setup') return res.redirect(`/cycles/${cycleId}`);
  const saved = await listReviews('r.cycle_id = $1', [cycleId]);
  const skills = await many('SELECT id, name FROM skills');
  const skillName = new Map(skills.map((s) => [s.id, s.name]));
  const savedSkills = new Map(
    (await many('SELECT id, skill1_id, skill2_id, skill3_id FROM reviews WHERE cycle_id = $1', [cycleId]))
      .map((r) => [r.id, [r.skill1_id, r.skill2_id, r.skill3_id].map((id) => skillName.get(id) || '')]),
  );
  for (const r of saved) r.skills = savedSkills.get(r.id) || [];
  const tree = buildTree(saved, res.locals.user, summary.cycle);
  return res.status(extra.status || 200).render('hr-setup', {
    title: `Set up ${summary.cycle.name}`,
    ...summary,
    saved,
    roots: tree.roots,
    STATUS_LABELS,
    preview: null,
    ...extra,
  });
}

export function hrRoutes() {
  const router = express.Router();
  router.use(requireHr);
  // Every :id in these routes must be a valid id.
  router.param('id', (req, res, next, value) => {
    const id = parseId(value);
    if (!id) return res.status(404).render('error', { title: 'Not found', message: "This page doesn't exist." });
    req.params.id = id;
    return next();
  });

  router.get('/', async (req, res) => {
    const cycles = await many(
      `SELECT c.*, (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id) AS people,
              (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id AND r.status = 'closed') AS closed
         FROM cycles c ORDER BY c.created_at DESC`,
    );
    const requests = (await one("SELECT count(*)::int AS n FROM change_requests WHERE status = 'open'")).n;
    res.render('hr-index', { title: 'HR', cycles, requests });
  });

  router.post('/cycles', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(req.body.deadline || '') ? req.body.deadline : null;
    if (!name) {
      flash(req, 'error', 'Give the cycle a name, e.g. "H2 2026".');
      return res.redirect('/hr');
    }
    if (await one('SELECT 1 FROM cycles WHERE lower(name) = lower($1)', [name])) {
      flash(req, 'error', `A cycle called "${name}" already exists.`);
      return res.redirect('/hr');
    }
    const c = await one(
      'INSERT INTO cycles (name, deadline, talent_bar, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, deadline, JSON.stringify(TALENT_BAR), req.user.id],
    );
    res.redirect(`/hr/cycles/${c.id}/setup`);
  });

  router.get('/template.xlsx', async (req, res) => {
    const buf = await buildTemplate(await skillNames());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="review-cycle-template.xlsx"');
    res.send(Buffer.from(buf));
  });

  router.get('/cycles/:id/setup', async (req, res) => renderSetup(res, Number(req.params.id), { setupWarnings: req.session.setupWarnings || [] }));

  router.post('/cycles/:id/roster', upload.single('file'), verifyCsrf, async (req, res) => {
    const cycleId = Number(req.params.id);
    if (!req.file) {
      flash(req, 'error', 'Choose the Excel file first.');
      return res.redirect(`/hr/cycles/${cycleId}/setup`);
    }
    const parsed = await parseRoster(req.file.buffer);
    if (parsed.fileErrors.length) {
      return renderSetup(res, cycleId, { status: 422, preview: { fileErrors: parsed.fileErrors, fileName: req.file.originalname } });
    }
    const validated = validateRoster(parsed, await skillNames());
    if (validated.errorCount) {
      return renderSetup(res, cycleId, { status: 422, preview: { ...validated, fileErrors: [], fileName: req.file.originalname } });
    }
    let n;
    try {
      n = await saveRoster(cycleId, validated, req.file.originalname);
    } catch (err) {
      flash(req, 'error', err.message);
      return res.redirect(`/cycles/${cycleId}`);
    }
    const warnings = validated.rows.flatMap((r) => r.warnings.map((w) => `Row ${r.rowNumber}: ${w}`));
    req.session.setupWarnings = warnings;
    flash(req, 'success', `List saved: ${n} people. Check it below, then initiate the cycle.`);
    res.redirect(`/hr/cycles/${cycleId}/setup`);
  });

  router.post('/cycles/:id/initiate', async (req, res) => {
    const cycleId = Number(req.params.id);
    const result = await initiateCycle(cycleId);
    if (!result.ok) {
      flash(req, 'error', result.error);
      return res.redirect(`/hr/cycles/${cycleId}/setup`);
    }
    delete req.session.setupWarnings;
    await safely(notifyInitiated(cycleId));
    flash(req, 'success', `Cycle initiated. ${result.count} reviews are now open for their managers.`);
    res.redirect(`/cycles/${cycleId}`);
  });

  router.post('/cycles/:id/delete', async (req, res) => {
    const cycleId = Number(req.params.id);
    const res1 = await query("DELETE FROM cycles WHERE id = $1 AND status = 'setup'", [cycleId]);
    flash(req, res1.rowCount ? 'success' : 'error', res1.rowCount ? 'Cycle deleted.' : 'Only cycles that are not initiated can be deleted.');
    res.redirect('/hr');
  });

  router.post('/cycles/:id/release', async (req, res) => {
    const cycleId = Number(req.params.id);
    if (req.body.confirm !== 'yes') {
      flash(req, 'error', 'Tick the box to confirm the release.');
      return res.redirect(`/cycles/${cycleId}`);
    }
    const result = await releaseCycle(cycleId);
    if (result.ok) await safely(notifyReleased(cycleId));
    flash(req, result.ok ? 'success' : 'error', result.ok ? 'Released. Employees can now see their reviews.' : result.error);
    res.redirect(`/cycles/${cycleId}`);
  });

  // Late joiner while the cycle is open.
  router.post('/cycles/:id/add', async (req, res) => {
    const cycleId = Number(req.params.id);
    const b = req.body;
    const row = {
      rowNumber: 1,
      employeeName: String(b.employeeName || '').trim(),
      employeeEmail: String(b.employeeEmail || '').trim(),
      department: String(b.department || '').trim(),
      position: String(b.position || '').trim(),
      seniority: String(b.seniority || '').trim(),
      reviewerName: String(b.reviewerName || '').trim(),
      reviewerEmail: String(b.reviewerEmail || '').trim(),
      skill1: String(b.skill1 || '').trim(),
      skill2: String(b.skill2 || '').trim(),
      skill3: String(b.skill3 || '').trim(),
    };
    const v = validateRoster({ employees: [row] }, await skillNames());
    const errors = v.rows[0].errors;
    if (errors.length) {
      flash(req, 'error', `Not added: ${errors.join(' ')}`);
      return res.redirect(`/cycles/${cycleId}#add`);
    }
    let result;
    try {
      result = await addReview(cycleId, v.rows[0], v.namesByEmail, req.user.id);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    flash(req, result.ok ? 'success' : 'error', result.ok ? `${row.employeeName} added to the cycle.` : result.error);
    res.redirect(`/cycles/${cycleId}`);
  });

  router.post('/reviews/:id/reassign', async (req, res) => {
    const id = Number(req.params.id);
    const email = String(req.body.reviewerEmail || '').trim().toLowerCase();
    const name = String(req.body.reviewerName || '').trim();
    if (!EMAIL_RE.test(email) || !name) {
      flash(req, 'error', 'Enter the new manager\'s name and a valid email.');
      const r = await one('SELECT cycle_id FROM reviews WHERE id = $1', [id]);
      return res.redirect(r ? `/cycles/${r.cycle_id}` : '/hr');
    }
    const result = await reassignReviewer(id, email, name, req.user.id);
    flash(req, result.ok ? 'success' : 'error', result.ok ? `Manager changed to ${name}.` : result.error);
    res.redirect(result.cycleId ? `/cycles/${result.cycleId}` : '/hr');
  });

  router.post('/reviews/:id/remove', async (req, res) => {
    const result = await removeReview(Number(req.params.id));
    flash(req, result.ok ? 'success' : 'error', result.ok ? 'Removed from the cycle.' : result.error);
    res.redirect(result.cycleId ? `/cycles/${result.cycleId}` : '/hr');
  });

  router.post('/reviews/:id/reopen', async (req, res) => {
    const id = Number(req.params.id);
    const result = await reopenReview(id, req.user.id);
    if (result.ok) await safely(notifyReopened(id));
    flash(req, result.ok ? 'success' : 'error', result.ok ? 'Reopened. The manager and their manager can edit it again; it goes through both steps again.' : result.error);
    res.redirect(req.body.back === 'cycle' && result.cycleId ? `/cycles/${result.cycleId}` : `/reviews/${id}`);
  });

  // Requests from managers to reopen a review.
  router.get('/requests', async (req, res) => {
    const rows = await many(
      `SELECT q.*, u.name AS requester_name, d.name AS decider_name, e.name AS employee_name, c.name AS cycle_name,
              r.status AS review_status, c.status AS cycle_status
         FROM change_requests q
         JOIN users u ON u.id = q.requested_by
         LEFT JOIN users d ON d.id = q.decided_by
         JOIN reviews r ON r.id = q.review_id
         JOIN users e ON e.id = r.employee_id
         JOIN cycles c ON c.id = r.cycle_id
        ORDER BY (q.status = 'open') DESC, q.created_at DESC
        LIMIT 200`,
    );
    res.render('hr-requests', { title: 'Change requests', open: rows.filter((r) => r.status === 'open'), done: rows.filter((r) => r.status !== 'open'), STATUS_LABELS });
  });

  router.post('/requests/:id/decide', async (req, res) => {
    const approve = req.body.decision === 'approve';
    const note = String(req.body.note || '').trim().slice(0, 2000);
    const result = await decideChange(Number(req.params.id), req.user.id, approve, note);
    if (result.ok) {
      await safely(notifyChangeDecided(result.reviewId, result.requester, approve, note));
      if (approve) await safely(notifyReopened(result.reviewId, { skipEmail: result.requester.email }));
    }
    flash(req, result.ok ? 'success' : 'error', result.ok ? (approve ? 'Approved: the review is reopened.' : 'Declined. The manager has been told.') : result.error);
    res.redirect('/hr/requests');
  });

  // Automatic emails: settings and a log of every email.
  router.get('/emails', async (req, res) => {
    const emails = await many('SELECT * FROM email_outbox ORDER BY created_at DESC, id DESC LIMIT 300');
    res.render('hr-emails', {
      title: 'Automatic emails',
      emails,
      settings: await getEmailSettings(),
      EMAIL_KINDS,
      sending: emailSendingEnabled(),
      mailFrom: config.mailFrom,
    });
  });

  router.post('/emails/settings', async (req, res) => {
    await saveEmailSettings(Object.fromEntries(Object.keys(EMAIL_KINDS).map((k) => [k, req.body[k] === 'on'])));
    flash(req, 'success', 'Email settings saved.');
    res.redirect('/hr/emails');
  });

  router.get('/skills', async (req, res) => {
    const skills = await many(
      `SELECT s.*, (SELECT count(*)::int FROM reviews r WHERE s.id IN (r.skill1_id, r.skill2_id, r.skill3_id)) AS used
         FROM skills s ORDER BY s.draft, s.name`,
    );
    res.render('hr-skills', { title: 'Skills', skills });
  });

  router.post('/skills', async (req, res) => {
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const definition = String(req.body.definition || '').trim().slice(0, 2000) || null;
    if (!name) {
      flash(req, 'error', 'Enter a skill name.');
      return res.redirect('/hr/skills');
    }
    const r = await query("INSERT INTO skills (name, definition, source) VALUES ($1, $2, 'hr') ON CONFLICT (name) DO NOTHING", [name, definition]);
    flash(req, r.rowCount ? 'success' : 'error', r.rowCount ? `Added "${name}".` : `"${name}" is already in the list.`);
    res.redirect('/hr/skills');
  });

  router.get('/settings', async (req, res) => {
    const people = await many("SELECT * FROM users WHERE global_role IS NOT NULL ORDER BY global_role, name");
    res.render('hr-settings', { title: 'Access settings', people });
  });

  router.post('/settings/role', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const role = ['hr_admin', 'viewer_all'].includes(req.body.role) ? req.body.role : null;
    if (!EMAIL_RE.test(email)) {
      flash(req, 'error', 'Enter a valid email.');
      return res.redirect('/hr/settings');
    }
    if (!role && email === req.user.email) {
      flash(req, 'error', "You can't remove your own HR access.");
      return res.redirect('/hr/settings');
    }
    if (role === 'hr_admin') {
      const n = (await one("SELECT count(*)::int AS n FROM users WHERE global_role = 'hr_admin' AND email <> $1", [email])).n;
      if (n >= 2) {
        flash(req, 'error', 'There can be at most two HR admins (HR manager plus one backup).');
        return res.redirect('/hr/settings');
      }
    }
    const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) await query('UPDATE users SET global_role = $2, name = COALESCE(NULLIF($3, \'\'), name) WHERE id = $1', [existing.id, role, name]);
    else if (role) {
      if (!name) {
        flash(req, 'error', 'Enter the person\'s name.');
        return res.redirect('/hr/settings');
      }
      await query('INSERT INTO users (email, name, global_role) VALUES ($1, $2, $3)', [email, name, role]);
    }
    flash(req, 'success', 'Access updated.');
    res.redirect('/hr/settings');
  });

  return router;
}

export { STATUS_LABELS, SENIORITIES };
