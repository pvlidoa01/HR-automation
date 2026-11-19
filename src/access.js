// Who may see and change what. Every page that shows review data goes through here.
//
// Decided rules (questions doc, 5 Nov 2026; reporting-line rules, 19 Nov 2026):
//   - HR admins (Daria + one backup): everything, can edit while the cycle is open.
//   - viewer_all (CEO): sees everything and can edit any review while the cycle is open (logged),
//     but is never part of the approval steps: never the second level, and their edits don't
//     change whether a review is complete. Reopening stays with HR. (19 Nov 2026)
//   - Reviewer = the employee's direct manager. Edits until they submit.
//   - Second level = the reviewer's own manager (the reviewer's reviewer in the same cycle).
//     Sees the review only once the reviewer has submitted it, can then edit it (HR action
//     points included) and confirms it, which closes it. If HR reopens a review, both can edit.
//     If the reviewer has no manager in the cycle, or their manager is the CEO, there is no second
//     level and the reviewer's submit closes the review.
//   - Discussion next to each review: manager, second level (once it reaches them), HR and CEO
//     read and write it while the cycle is open; read-only after release. Never the employee.
//   - Nobody else above sees the review: each head's branch is independent.
//   - After a submit, the reviewer (and after closing, the second level) can only ask HR to reopen.
//   - A new manager can read their report's reviews from earlier, released cycles (no HR points).
//   - Employee: only their own review, and only after the cycle is released.
//     Never the HR action points or the change log.
import { one } from './db.js';

const NONE = Object.freeze({
  canView: false,
  canEdit: false,
  canSubmit: false,
  canRequestChange: false,
  canSeeHrPoints: false,
  canSeeChangeLog: false,
  canComment: false,
  isEmployee: false,
  role: null,
});

const REVIEWER_EDITABLE = ['not_started', 'draft'];

/** The step a submit by this user would complete, or null. */
function submitStep(user, review, facts) {
  if (review.reviewer_id === user.id && REVIEWER_EDITABLE.includes(review.status)) return 'reviewer';
  if (facts.confirmerId === user.id && review.status === 'submitted') return 'confirmer';
  return null;
}

/**
 * Pure rule function so it can be tested without a database.
 * @param {{id:number, global_role:string|null}} user
 * @param {{employee_id:number, reviewer_id:number, status:string, first_submitted_at:any}} review
 * @param {{status:string}} cycle
 * @param {{confirmerId?:number|null, isLaterManager?:boolean}} facts
 */
export function reviewAccess(user, review, cycle, facts = {}) {
  if (!user || !review || !cycle) return NONE;
  const open = cycle.status === 'open';
  const released = cycle.status === 'released';
  const started = cycle.status !== 'setup';
  const seenBySecond = !!review.first_submitted_at;

  // Your own review: employee rules always apply, whatever other access you have.
  if (review.employee_id === user.id) {
    return released ? { ...NONE, canView: true, isEmployee: true, role: 'employee' } : NONE;
  }
  if (user.global_role === 'hr_admin') {
    return {
      ...NONE,
      canView: true,
      canEdit: open,
      canSubmit: open && !!submitStep(user, review, facts),
      canSeeHrPoints: true,
      canSeeChangeLog: true,
      canComment: open,
      role: 'hr',
    };
  }
  const isCeo = user.global_role === 'viewer_all';
  // Before the CEO rule, so a CEO who reviews someone writes and submits that review. Once it is
  // submitted the CEO rule applies to them like to any other review.
  const reviewerEditable = open && REVIEWER_EDITABLE.includes(review.status);
  if (review.reviewer_id === user.id && started && !(isCeo && !reviewerEditable)) {
    const editable = reviewerEditable;
    return {
      ...NONE,
      canView: true,
      canEdit: editable,
      canSubmit: editable,
      canRequestChange: open && ['submitted', 'closed'].includes(review.status),
      canSeeHrPoints: true,
      canSeeChangeLog: true,
      canComment: open,
      role: 'reviewer',
    };
  }
  if (facts.confirmerId && facts.confirmerId === user.id && started && seenBySecond) {
    const editable = open && (review.status === 'submitted' || review.status === 'draft');
    return {
      ...NONE,
      canView: true,
      canEdit: editable,
      canSubmit: open && review.status === 'submitted',
      canRequestChange: open && review.status === 'closed',
      canSeeHrPoints: true,
      canSeeChangeLog: true,
      canComment: open,
      role: 'confirmer',
    };
  }
  if (isCeo && started) {
    return { ...NONE, canView: true, canEdit: open, canSeeHrPoints: true, canSeeChangeLog: true, canComment: open, role: 'ceo' };
  }
  if (facts.isLaterManager && released) {
    return { ...NONE, canView: true, role: 'later_manager' };
  }
  return NONE;
}

/**
 * The second level for a review: the reviewer's own reviewer in the same cycle, or null.
 * Never the CEO: reviews written by people who report to the CEO close on the manager's submit.
 */
export async function confirmerFor(cycleId, reviewerId, db = { one }) {
  const row = await db.one(
    `SELECT r.reviewer_id FROM reviews r JOIN users u ON u.id = r.reviewer_id
      WHERE r.cycle_id = $1 AND r.employee_id = $2 AND u.global_role IS DISTINCT FROM 'viewer_all'`,
    [cycleId, reviewerId],
  );
  return row ? row.reviewer_id : null;
}

/** Closes reviews still waiting for a second level that no longer exists (e.g. the CEO). */
export async function closeReviewsWithoutSecondLevel(db) {
  const res = await db.query(
    `WITH waiting AS (
       SELECT r.id FROM reviews r
         JOIN cycles c ON c.id = r.cycle_id AND c.status = 'open'
         LEFT JOIN reviews mr ON mr.cycle_id = r.cycle_id AND mr.employee_id = r.reviewer_id
         LEFT JOIN users s ON s.id = mr.reviewer_id
        WHERE r.status = 'submitted' AND (mr.id IS NULL OR s.global_role = 'viewer_all')
     ), closed AS (
       UPDATE reviews SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM waiting) RETURNING id
     )
     INSERT INTO change_log (review_id, user_id, field)
     SELECT id, NULL, 'Completed: there is no second level to confirm it' FROM closed`,
  );
  return res.rowCount;
}

/** Loads the facts reviewAccess needs and returns { review, cycle, access, confirmerId }. */
export async function loadReviewWithAccess(user, reviewId) {
  const review = await one('SELECT * FROM reviews WHERE id = $1', [reviewId]);
  if (!review) return { review: null, cycle: null, access: NONE, confirmerId: null };
  const cycle = await one('SELECT * FROM cycles WHERE id = $1', [review.cycle_id]);
  const facts = { confirmerId: await confirmerFor(review.cycle_id, review.reviewer_id) };
  if (user && !user.global_role && review.reviewer_id !== user.id && review.employee_id !== user.id && facts.confirmerId !== user.id) {
    facts.isLaterManager = !!(await one(
      `SELECT 1 FROM reviews r JOIN cycles c ON c.id = r.cycle_id
        WHERE r.employee_id = $1 AND r.reviewer_id = $2 AND c.status <> 'setup' AND c.id > $3`,
      [review.employee_id, user.id, review.cycle_id],
    ));
  }
  return { review, cycle, access: reviewAccess(user, review, cycle, facts), confirmerId: facts.confirmerId };
}

/** Rechecks edit rights inside a save transaction, on freshly locked rows. */
export function canEditNow(role, review, cycleStatus) {
  if (cycleStatus !== 'open') return false;
  if (role === 'hr' || role === 'ceo') return true;
  if (role === 'reviewer') return REVIEWER_EDITABLE.includes(review.status);
  if (role === 'confirmer') return !!review.first_submitted_at && (review.status === 'submitted' || review.status === 'draft');
  return false;
}

/** Positive 32-bit integer id from a URL parameter, or null. */
export function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

export function isHr(user) {
  return user?.global_role === 'hr_admin';
}

export function seesEverything(user) {
  return user?.global_role === 'hr_admin' || user?.global_role === 'viewer_all';
}
