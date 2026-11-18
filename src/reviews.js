// Loading and saving reviews.
import { one, many, tx } from './db.js';
import { DIMENSIONS, STATEMENTS, DIMENSION_INTROS, LEVEL_KEYS } from './shared/framework.js';
import { computeGrades } from './shared/scoring.js';
import { hasChecklist } from './shared/checklist.js';
import { canEditNow } from './access.js';

const SKILL_DIMS = { skill1: 'skill1_id', skill2: 'skill2_id', skill3: 'skill3_id' };

export async function getReviewDetail(reviewId) {
  const review = await one(
    `SELECT r.*, e.name AS employee_name, e.email AS employee_email,
            m.name AS reviewer_name, m.email AS reviewer_email,
            c.name AS cycle_name, c.status AS cycle_status, c.deadline, c.talent_bar
       FROM reviews r
       JOIN users e ON e.id = r.employee_id
       JOIN users m ON m.id = r.reviewer_id
       JOIN cycles c ON c.id = r.cycle_id
      WHERE r.id = $1`,
    [reviewId],
  );
  if (!review) return null;
  const skillIds = Object.values(SKILL_DIMS).map((col) => review[col]).filter(Boolean);
  const skills = skillIds.length ? await many('SELECT * FROM skills WHERE id = ANY($1)', [skillIds]) : [];
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const rows = await many('SELECT * FROM review_dimensions WHERE review_id = $1', [reviewId]);
  const byDim = new Map(rows.map((r) => [r.dimension, r]));

  const ratings = {};
  const dimensions = DIMENSIONS.map((d) => {
    const saved = byDim.get(d.key) || { rating: null, feedback: '', checklist: {} };
    let label = d.label;
    let statements = STATEMENTS[d.key] || null;
    let intro = DIMENSION_INTROS[d.key] || '';
    let skill = null;
    if (SKILL_DIMS[d.key]) {
      skill = skillById.get(review[SKILL_DIMS[d.key]]) || null;
      label = skill ? skill.name : `${d.label} (not set)`;
      statements = skill && hasChecklist(skill.levels) ? skill.levels : null;
      intro = skill?.definition || '';
    }
    ratings[d.key] = saved.rating;
    return {
      key: d.key,
      category: d.category,
      slot: d.label,
      label,
      intro,
      statements,
      rating: saved.rating,
      feedback: saved.feedback,
      checklist: saved.checklist || {},
    };
  });

  const grades = computeGrades(ratings, review.seniority, review.talent_bar);
  for (const d of dimensions) {
    d.expected = grades.dimensions[d.key].expected;
    d.diff = grades.dimensions[d.key].diff;
  }
  return { review, dimensions, grades };
}

export async function getChangeLog(reviewId) {
  return many(
    `SELECT l.*, u.name AS user_name FROM change_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.review_id = $1 ORDER BY l.at DESC, l.id DESC`,
    [reviewId],
  );
}

function cleanText(v, max = 10000) {
  return String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function parseChecklist(raw, statements) {
  const out = {};
  if (!raw || !statements) return out;
  for (const lvl of LEVEL_KEYS) {
    const items = statements[lvl] || [];
    const given = raw[lvl] || {};
    items.forEach((_, i) => {
      const v = given[i] ?? given[String(i)];
      if (v === 'yes' || v === 'no') {
        out[lvl] = out[lvl] || {};
        out[lvl][i] = v;
      }
    });
  }
  return out;
}

/** Version token for optimistic locking: changes whenever the review row is saved. */
export function versionOf(review) {
  return String(new Date(review.updated_at).getTime());
}

/**
 * Saves the review form. `action` is 'save' or 'submit'; `role` comes from access.js.
 * Logged: every change by someone other than the reviewer (HR calibration), and every change
 * to a review that is already submitted.
 * Returns { ok, errors, conflict }.
 */
export async function saveReview(user, detail, body, action, role) {
  const { review, dimensions } = detail;
  const logChanges = user.id !== review.reviewer_id || review.status === 'submitted';
  const ratingsIn = body.rating || {};
  const feedbackIn = body.feedback || {};
  const checklistIn = body.chk || {};

  const updates = dimensions.map((d) => {
    const r = ratingsIn[d.key];
    const rating = r === undefined || r === '' ? null : Number(r);
    return {
      key: d.key,
      label: d.label,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      feedback: cleanText(feedbackIn[d.key]),
      checklist: parseChecklist(checklistIn[d.key], d.statements),
      before: d,
    };
  });
  const actionPlan = cleanText(body.action_plan);
  const hrPoints = cleanText(body.hr_action_points);

  const errors = [];
  if (action === 'submit') {
    const missing = updates.filter((u) => u.rating == null).map((u) => u.label);
    if (missing.length) errors.push(`Add a rating for: ${missing.join(', ')}.`);
  }
  if (errors.length) return { ok: false, errors };

  return tx(async (client) => {
    // Re-check on locked rows so a release, submit or someone else's save can't slip in between.
    const cycleStatus = (await client.query('SELECT status FROM cycles WHERE id = $1 FOR SHARE', [review.cycle_id])).rows[0]?.status;
    const current = (await client.query('SELECT status, updated_at FROM reviews WHERE id = $1 FOR UPDATE', [review.id])).rows[0];
    if (!current || !canEditNow(role, current, cycleStatus)) {
      return { ok: false, errors: ['This review can no longer be changed.'], locked: true };
    }
    if (String(body.version || '') !== versionOf(current)) {
      return {
        ok: false,
        conflict: true,
        errors: ['Someone else saved this review after you opened it. Your changes are below but were NOT saved. Reload the page to see the latest version, then make your changes again.'],
      };
    }
    for (const u of updates) {
      await client.query(
        `INSERT INTO review_dimensions (review_id, dimension, rating, feedback, checklist)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (review_id, dimension)
         DO UPDATE SET rating = EXCLUDED.rating, feedback = EXCLUDED.feedback, checklist = EXCLUDED.checklist`,
        [review.id, u.key, u.rating, u.feedback, JSON.stringify(u.checklist)],
      );
      if (logChanges) {
        if ((u.before.rating ?? null) !== u.rating) {
          await log(client, review.id, user.id, `${u.label}: rating`, u.before.rating, u.rating);
        }
        if ((u.before.feedback || '') !== u.feedback) {
          await log(client, review.id, user.id, `${u.label}: feedback`, u.before.feedback, u.feedback);
        }
        if (JSON.stringify(normalizeChecklist(u.before.checklist)) !== JSON.stringify(normalizeChecklist(u.checklist))) {
          await log(client, review.id, user.id, `${u.label}: checklist answers changed`, null, null);
        }
      }
    }
    if (logChanges) {
      if ((review.action_plan || '') !== actionPlan) await log(client, review.id, user.id, 'Action plan', review.action_plan, actionPlan);
      if ((review.hr_action_points || '') !== hrPoints) await log(client, review.id, user.id, 'HR action points', review.hr_action_points, hrPoints);
    }
    let status = review.status;
    if (action === 'submit') status = 'submitted';
    else if (status === 'not_started') status = 'draft';
    await client.query(
      `UPDATE reviews SET action_plan = $2, hr_action_points = $3, status = $4,
              submitted_at = CASE WHEN $4 = 'submitted' AND submitted_at IS NULL THEN now() ELSE submitted_at END,
              updated_at = now()
        WHERE id = $1`,
      [review.id, actionPlan, hrPoints, status],
    );
    if (action === 'submit' && review.status !== 'submitted') {
      await log(client, review.id, user.id, 'Submitted', null, null);
    }
    return { ok: true, errors: [] };
  });
}

function normalizeChecklist(c) {
  const out = {};
  for (const lvl of Object.keys(c || {}).sort()) {
    const entries = Object.entries(c[lvl] || {}).filter(([, v]) => v === 'yes' || v === 'no').sort(([a], [b]) => Number(a) - Number(b));
    if (entries.length) out[lvl] = Object.fromEntries(entries);
  }
  return out;
}

export async function log(client, reviewId, userId, field, oldValue, newValue) {
  await client.query(
    'INSERT INTO change_log (review_id, user_id, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
    [reviewId, userId, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue)],
  );
}

/** Review rows with names and an overall grade, for list pages. */
export async function listReviews(where, params) {
  const rows = await many(
    `SELECT r.id, r.cycle_id, r.employee_id, r.reviewer_id, r.department, r.position, r.seniority, r.status,
            r.submitted_at, r.employee_read_at, r.updated_at,
            e.name AS employee_name, e.email AS employee_email,
            m.name AS reviewer_name, m.email AS reviewer_email,
            c.name AS cycle_name, c.status AS cycle_status, c.talent_bar, c.deadline,
            COALESCE(json_object_agg(d.dimension, d.rating) FILTER (WHERE d.dimension IS NOT NULL), '{}') AS ratings
       FROM reviews r
       JOIN users e ON e.id = r.employee_id
       JOIN users m ON m.id = r.reviewer_id
       JOIN cycles c ON c.id = r.cycle_id
       LEFT JOIN review_dimensions d ON d.review_id = r.id
      WHERE ${where}
      GROUP BY r.id, e.id, m.id, c.id
      ORDER BY c.created_at DESC, r.department, e.name`,
    params,
  );
  for (const r of rows) {
    r.grades = computeGrades(r.ratings, r.seniority, r.talent_bar);
    delete r.talent_bar;
  }
  return rows;
}

export const STATUS_LABELS = {
  not_started: 'Not started',
  draft: 'In progress',
  submitted: 'Submitted',
};
