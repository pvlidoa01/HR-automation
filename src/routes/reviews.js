import express from 'express';
import { query } from '../db.js';
import { loadReviewWithAccess, parseId } from '../access.js';
import { getReviewDetail, getChangeLog, saveReview, versionOf, STATUS_LABELS } from '../reviews.js';
import { flash } from '../app.js';
import { LEVELS, LEVEL_KEYS } from '../shared/framework.js';

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: "This review doesn't exist or you don't have access to it." });

async function renderReview(res, id, access, extra = {}) {
  const detail = extra.detail || (await getReviewDetail(id));
  res.status(extra.status || 200).render('review', {
    title: `${detail.review.employee_name} · ${detail.review.cycle_name}`,
    ...detail,
    access,
    changeLog: access.canSeeChangeLog ? await getChangeLog(id) : [],
    errors: extra.errors || [],
    version: extra.version || versionOf(detail.review),
    LEVELS,
    LEVEL_KEYS,
    STATUS_LABELS,
  });
}

export function reviewRoutes() {
  const router = express.Router();

  router.get('/reviews/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    const { access } = await loadReviewWithAccess(req.user, id);
    if (!access.canView) return notFound(res);
    return renderReview(res, id, access);
  });

  router.post('/reviews/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    const { access } = await loadReviewWithAccess(req.user, id);
    if (!access.canView) return notFound(res);
    if (!access.canEdit) {
      flash(req, 'error', 'This review can no longer be changed.');
      return res.redirect(`/reviews/${id}`);
    }
    // A real form always sends the rating fields and a version; refuse anything else.
    if (!req.body || typeof req.body.rating !== 'object' || !req.body.version) {
      return res.status(400).render('error', { title: 'Not saved', message: 'The form was incomplete. Reload the page and try again.' });
    }
    const action = req.body.action === 'submit' ? 'submit' : 'save';
    const detail = await getReviewDetail(id);
    // HR editing someone else's review does not submit on the manager's behalf.
    const effectiveAction = access.role === 'hr' && detail.review.reviewer_id !== req.user.id ? 'save' : action;
    const result = await saveReview(req.user, detail, req.body, effectiveAction, access.role);
    if (result.locked) {
      flash(req, 'error', result.errors[0]);
      return res.redirect(`/reviews/${id}`);
    }
    if (!result.ok) {
      // Show the form again with what the user typed, so nothing is lost.
      detail.review.action_plan = String(req.body.action_plan ?? '');
      detail.review.hr_action_points = String(req.body.hr_action_points ?? '');
      for (const d of detail.dimensions) {
        const r = Number(req.body.rating?.[d.key]);
        d.rating = Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
        d.feedback = String(req.body.feedback?.[d.key] ?? '');
        d.checklist = req.body.chk?.[d.key] || {};
      }
      return renderReview(res, id, access, {
        detail,
        status: result.conflict ? 409 : 422,
        errors: result.errors,
        version: String(req.body.version),
      });
    }
    if (effectiveAction === 'submit') {
      flash(req, 'success', `Review for ${detail.review.employee_name} submitted.`);
      return res.redirect(access.role === 'reviewer' ? '/team' : `/reviews/${id}`);
    }
    flash(req, 'success', 'Saved.');
    return res.redirect(`/reviews/${id}`);
  });

  router.post('/reviews/:id/read', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    const { access } = await loadReviewWithAccess(req.user, id);
    if (!access.isEmployee) return notFound(res);
    const comment = String(req.body?.employee_comment ?? '').trim().slice(0, 5000);
    await query(
      'UPDATE reviews SET employee_read_at = COALESCE(employee_read_at, now()), employee_comment = $2 WHERE id = $1',
      [id, comment],
    );
    flash(req, 'success', 'Thanks, your manager and HR can see that you have read your review.');
    res.redirect(`/reviews/${id}`);
  });

  return router;
}
