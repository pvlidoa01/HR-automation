import express from 'express';
import { query, one } from '../db.js';
import { loadReviewWithAccess, parseId, seesEverything } from '../access.js';
import { getReviewDetail, getActivity, addComment, markSeen, saveReview, versionOf, STATUS_LABELS } from '../reviews.js';
import { flash } from '../app.js';
import { requestChange } from '../cycles.js';
import { notifySubmitted, notifyChangeRequested, safely } from '../notify.js';
import { LEVELS, LEVEL_KEYS } from '../shared/framework.js';

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: "This review doesn't exist or you don't have access to it." });

async function renderReview(res, id, access, extra = {}) {
  const userId = res.locals.user?.id;
  // When this person last opened the review: items after that are marked "new". Then mark it seen.
  let newSince = null;
  if (access.canSeeChangeLog && userId) {
    newSince = (await one('SELECT seen_at FROM review_seen WHERE user_id = $1 AND review_id = $2', [userId, id]))?.seen_at || null;
    await markSeen(userId, id);
  }
  const detail = extra.detail || (await getReviewDetail(id));
  const openRequest = await one(
    `SELECT q.*, u.name AS requester_name FROM change_requests q JOIN users u ON u.id = q.requested_by
      WHERE q.review_id = $1 AND q.status = 'open'`,
    [id],
  );
  const confirmer = extra.confirmerId ? await one('SELECT name FROM users WHERE id = $1', [extra.confirmerId]) : null;
  res.status(extra.status || 200).render('review', {
    openRequest: access.canSeeChangeLog ? openRequest : null,
    confirmerName: confirmer?.name || null,
    title: `${detail.review.employee_name} · ${detail.review.cycle_name}`,
    ...detail,
    access,
    activity: access.canSeeChangeLog ? await getActivity(id) : [],
    newSince,
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
    const { access, confirmerId } = await loadReviewWithAccess(req.user, id);
    if (!access.canView) return notFound(res);
    return renderReview(res, id, access, { confirmerId });
  });

  router.post('/reviews/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    const { access, confirmerId } = await loadReviewWithAccess(req.user, id);
    if (!access.canView) return notFound(res);
    if (!access.canEdit) {
      flash(req, 'error', 'This review can no longer be changed.');
      return res.redirect(`/reviews/${id}`);
    }
    // A real form always sends the rating fields and a version; refuse anything else.
    if (!req.body || typeof req.body.rating !== 'object' || !req.body.version) {
      return res.status(400).render('error', { title: 'Not saved', message: 'The form was incomplete. Reload the page and try again.' });
    }
    // Only the manager or the second level can submit; HR saves on nobody's behalf.
    const action = req.body.action === 'submit' && access.canSubmit ? 'submit' : 'save';
    const detail = await getReviewDetail(id);
    const result = await saveReview(req.user, detail, req.body, action, access.role, confirmerId);
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
        confirmerId,
      });
    }
    if (result.step) {
      await safely(notifySubmitted(id, result.status === 'closed' ? (result.step === 'confirmer' ? 'confirmer' : 'final') : 'reviewer'));
      const msg = result.status === 'closed'
        ? `Review for ${detail.review.employee_name} is complete.`
        : `Review for ${detail.review.employee_name} submitted. It now goes to your manager to confirm.`;
      flash(req, 'success', msg);
      return res.redirect('/team');
    }
    flash(req, 'success', 'Saved.');
    return res.redirect(`/reviews/${id}`);
  });

  // Posting a message. The review page sends it in the background (header X-Requested-With: fetch)
  // so that unsaved changes in the review form are kept; without JavaScript it is a normal form post.
  router.post('/reviews/:id/comments', async (req, res) => {
    const inBackground = req.get('x-requested-with') === 'fetch';
    const fail = (status, error) => (inBackground ? res.status(status).json({ ok: false, error }) : null);
    const id = parseId(req.params.id);
    if (!id) return fail(404, 'This review does not exist.') || notFound(res);
    const { access } = await loadReviewWithAccess(req.user, id);
    if (!access.canSeeChangeLog) return fail(404, 'This review does not exist.') || notFound(res);
    if (!access.canComment) {
      if (inBackground) return fail(403, 'The discussion is closed for this review.');
      flash(req, 'error', 'The discussion is closed for this review.');
      return res.redirect(`/reviews/${id}#activity`);
    }
    const result = await addComment(id, req.user.id, req.body?.body);
    if (result.ok) await markSeen(req.user.id, id);
    if (inBackground) {
      if (!result.ok) return fail(400, result.error);
      const c = result.comment;
      return res.json({ ok: true, comment: { id: c.id, body: c.body, at: c.created_at, atLabel: res.locals.fmtDateTime(c.created_at), user_name: req.user.name } });
    }
    if (!result.ok) flash(req, 'error', result.error);
    return res.redirect(`/reviews/${id}#activity`);
  });

  router.post('/reviews/:id/request-change', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    const { access } = await loadReviewWithAccess(req.user, id);
    if (!access.canView) return notFound(res);
    const back = String(req.body?.back || '') === 'team' ? (seesEverything(req.user) ? '/team' : '/') : `/reviews/${id}`;
    if (!access.canRequestChange) {
      flash(req, 'error', 'You cannot ask to reopen this review.');
      return res.redirect(back);
    }
    const reason = String(req.body?.reason ?? '').trim().slice(0, 2000);
    if (reason.length < 5) {
      flash(req, 'error', 'Write a short explanation of what you want to change, so HR can decide.');
      return res.redirect(back);
    }
    const result = await requestChange(id, req.user.id, reason);
    if (result.ok) await safely(notifyChangeRequested(id, req.user, reason));
    flash(req, result.ok ? 'success' : 'error', result.ok ? 'Request sent to HR. You will be told when they decide.' : result.error);
    return res.redirect(back);
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
