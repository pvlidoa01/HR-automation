// Who may see and change what. Every page that shows review data goes through here.
//
// Decided rules (questions doc + follow-ups, 5 Nov 2026):
//   - HR admins (Daria + one backup): everything, can edit while the cycle is open.
//   - viewer_all (CEO): everything, read-only.
//   - The reviewer (direct manager): their own reports. Can edit until they submit.
//   - Department head: reviews in their department, read-only, once the manager has submitted.
//     No HR action points.
//   - A new manager can read their report's reviews from earlier cycles, read-only,
//     without the earlier HR action points.
//   - Employee: only their own review, and only after the cycle is released.
//     Never the HR action points or the change log.
import { one } from './db.js';

const NONE = Object.freeze({
  canView: false,
  canEdit: false,
  canSeeHrPoints: false,
  canSeeChangeLog: false,
  isEmployee: false,
  role: null,
});

/**
 * Pure rule function so it can be tested without a database.
 * @param {{id:number, global_role:string|null}} user
 * @param {{employee_id:number, reviewer_id:number, status:string}} review
 * @param {{status:string}} cycle
 * @param {{isDeptHead?:boolean, isLaterManager?:boolean}} facts
 */
export function reviewAccess(user, review, cycle, facts = {}) {
  if (!user || !review || !cycle) return NONE;
  const open = cycle.status === 'open';
  const released = cycle.status === 'released';
  const started = cycle.status !== 'setup';

  // Your own review: employee rules always apply, whatever other access you have
  // (an HR admin or department head never sees their own review early or their own HR points).
  if (review.employee_id === user.id) {
    return released ? { ...NONE, canView: true, isEmployee: true, role: 'employee' } : NONE;
  }
  if (user.global_role === 'hr_admin') {
    return { ...NONE, canView: true, canEdit: open, canSeeHrPoints: true, canSeeChangeLog: true, role: 'hr' };
  }
  // Before viewer_all, so a CEO who reviews someone can write that review.
  if (review.reviewer_id === user.id && started) {
    return {
      ...NONE,
      canView: true,
      canEdit: open && review.status !== 'submitted',
      canSeeHrPoints: true,
      canSeeChangeLog: true,
      role: 'reviewer',
    };
  }
  if (user.global_role === 'viewer_all' && started) {
    return { ...NONE, canView: true, canSeeHrPoints: true, canSeeChangeLog: true, role: 'ceo' };
  }
  if (facts.isDeptHead && started && (review.status === 'submitted' || released)) {
    return { ...NONE, canView: true, role: 'dept_head' };
  }
  if (facts.isLaterManager && released) {
    return { ...NONE, canView: true, role: 'later_manager' };
  }
  return NONE;
}

/** Loads the facts reviewAccess needs and returns { review, cycle, access }. */
export async function loadReviewWithAccess(user, reviewId) {
  const review = await one('SELECT * FROM reviews WHERE id = $1', [reviewId]);
  if (!review) return { review: null, cycle: null, access: NONE };
  const cycle = await one('SELECT * FROM cycles WHERE id = $1', [review.cycle_id]);
  const facts = {};
  if (user && user.global_role !== 'hr_admin' && review.reviewer_id !== user.id && review.employee_id !== user.id) {
    facts.isDeptHead = !!(await one(
      'SELECT 1 FROM cycle_departments WHERE cycle_id = $1 AND name = $2 AND head_user_id = $3',
      [review.cycle_id, review.department, user.id],
    ));
    if (!facts.isDeptHead) {
      facts.isLaterManager = !!(await one(
        `SELECT 1 FROM reviews r JOIN cycles c ON c.id = r.cycle_id
          WHERE r.employee_id = $1 AND r.reviewer_id = $2 AND c.status <> 'setup' AND c.id > $3`,
        [review.employee_id, user.id, review.cycle_id],
      ));
    }
  }
  return { review, cycle, access: reviewAccess(user, review, cycle, facts) };
}

/** Rechecks edit rights inside a save transaction, on freshly locked rows. */
export function canEditNow(role, review, cycleStatus) {
  if (cycleStatus !== 'open') return false;
  if (role === 'hr') return true;
  if (role === 'reviewer') return review.status !== 'submitted';
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
