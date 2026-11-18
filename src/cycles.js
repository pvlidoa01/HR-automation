// Cycle set-up and changes HR makes to the list of people in a cycle.
import { one, many, tx } from './db.js';
import { log } from './reviews.js';

const key = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

async function upsertUser(client, email, name) {
  const { rows } = await client.query(
    `INSERT INTO users (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email, name],
  );
  return rows[0].id;
}

async function skillIdsByName(client, names) {
  const { rows } = await client.query('SELECT id, name FROM skills');
  const map = new Map(rows.map((r) => [key(r.name), r.id]));
  for (const n of names) {
    if (!map.has(key(n))) {
      const res = await client.query(
        "INSERT INTO skills (name, source) VALUES ($1, 'hr') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [n],
      );
      map.set(key(n), res.rows[0].id);
    }
  }
  return map;
}

/** Replaces the cycle's employee list with a checked upload. Only while the cycle is in set-up. */
export async function saveRoster(cycleId, validated, fileName) {
  return tx(async (client) => {
    const cycle = (await client.query('SELECT status FROM cycles WHERE id = $1 FOR UPDATE', [cycleId])).rows[0];
    if (!cycle || cycle.status !== 'setup') throw new Error('The list can only be replaced before the cycle is initiated.');
    const userIds = new Map();
    for (const [email, name] of validated.namesByEmail) userIds.set(email, await upsertUser(client, email, name));
    const skills = await skillIdsByName(client, validated.rows.flatMap((r) => r.skills));

    await client.query('DELETE FROM reviews WHERE cycle_id = $1', [cycleId]);
    await client.query('DELETE FROM cycle_departments WHERE cycle_id = $1', [cycleId]);
    const canonicalDept = new Map();
    for (const d of validated.departments) {
      canonicalDept.set(key(d.name), d.name);
      await client.query('INSERT INTO cycle_departments (cycle_id, name, head_user_id) VALUES ($1, $2, $3)', [
        cycleId,
        d.name,
        d.headEmail ? userIds.get(d.headEmail) : null,
      ]);
    }
    for (const r of validated.rows) {
      await client.query(
        `INSERT INTO reviews (cycle_id, employee_id, reviewer_id, department, position, seniority, skill1_id, skill2_id, skill3_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cycleId,
          userIds.get(r.employeeEmail),
          userIds.get(r.reviewerEmail),
          canonicalDept.get(key(r.department)) || r.department,
          r.position,
          r.seniority,
          ...r.skills.map((s) => skills.get(key(s))),
        ],
      );
    }
    await client.query('UPDATE cycles SET roster_file = $2 WHERE id = $1', [cycleId, fileName]);
    return validated.rows.length;
  });
}

export async function initiateCycle(cycleId) {
  return tx(async (client) => {
    const c = (await client.query('SELECT status FROM cycles WHERE id = $1 FOR UPDATE', [cycleId])).rows[0];
    if (!c || c.status !== 'setup') return { ok: false, error: 'This cycle has already been initiated.' };
    const n = (await client.query('SELECT count(*)::int AS n FROM reviews WHERE cycle_id = $1', [cycleId])).rows[0].n;
    if (!n) return { ok: false, error: 'Upload the employee list first.' };
    await client.query("UPDATE cycles SET status = 'open', initiated_at = now() WHERE id = $1", [cycleId]);
    return { ok: true, count: n };
  });
}

export async function releaseCycle(cycleId) {
  return tx(async (client) => {
    const c = (await client.query('SELECT status FROM cycles WHERE id = $1 FOR UPDATE', [cycleId])).rows[0];
    if (!c || c.status !== 'open') return { ok: false, error: 'Only an open cycle can be released.' };
    const pending = (await client.query(
      "SELECT count(*)::int AS n FROM reviews WHERE cycle_id = $1 AND status <> 'submitted'",
      [cycleId],
    )).rows[0].n;
    if (pending) return { ok: false, error: `${pending} review(s) are not submitted yet. All reviews must be submitted before release.` };
    await client.query("UPDATE cycles SET status = 'released', released_at = now() WHERE id = $1", [cycleId]);
    return { ok: true };
  });
}

/** Adds one person to a cycle that is open (late joiner). `row` is a validated roster row. */
export async function addReview(cycleId, row, namesByEmail, actorId) {
  return tx(async (client) => {
    const c = (await client.query('SELECT status FROM cycles WHERE id = $1 FOR UPDATE', [cycleId])).rows[0];
    if (!c || c.status !== 'open') throw new Error('People can only be added while the cycle is open.');
    const employeeId = await upsertUser(client, row.employeeEmail, namesByEmail.get(row.employeeEmail));
    const reviewerId = await upsertUser(client, row.reviewerEmail, namesByEmail.get(row.reviewerEmail));
    const exists = (await client.query('SELECT 1 FROM reviews WHERE cycle_id = $1 AND employee_id = $2', [cycleId, employeeId])).rows[0];
    if (exists) return { ok: false, error: `${row.employeeEmail} is already in this cycle.` };
    const skills = await skillIdsByName(client, row.skills);
    const dept = (await client.query('SELECT name FROM cycle_departments WHERE cycle_id = $1 AND lower(name) = lower($2)', [cycleId, row.department])).rows[0];
    if (!dept) await client.query('INSERT INTO cycle_departments (cycle_id, name) VALUES ($1, $2)', [cycleId, row.department]);
    const { rows } = await client.query(
      `INSERT INTO reviews (cycle_id, employee_id, reviewer_id, department, position, seniority, skill1_id, skill2_id, skill3_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [cycleId, employeeId, reviewerId, dept ? dept.name : row.department, row.position, row.seniority, ...row.skills.map((s) => skills.get(key(s)))],
    );
    await log(client, rows[0].id, actorId, 'Added to the cycle by HR', null, null);
    return { ok: true, id: rows[0].id };
  });
}

export async function reassignReviewer(reviewId, email, name, actorId) {
  return tx(async (client) => {
    const r = (await client.query(
      `SELECT r.*, c.status AS cycle_status, u.email AS reviewer_email, e.email AS employee_email
         FROM reviews r JOIN cycles c ON c.id = r.cycle_id JOIN users u ON u.id = r.reviewer_id JOIN users e ON e.id = r.employee_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [reviewId],
    )).rows[0];
    if (!r) return { ok: false, error: 'This review no longer exists.' };
    if (r.cycle_status === 'released') return { ok: false, error: 'This review can no longer be changed.', cycleId: r.cycle_id };
    if (r.status === 'submitted') return { ok: false, error: 'This review is already submitted. Reopen it first.', cycleId: r.cycle_id };
    if (email === r.employee_email) return { ok: false, error: 'An employee cannot be their own reviewer.' };
    const newId = await upsertUser(client, email, name);
    await client.query('UPDATE reviews SET reviewer_id = $2, updated_at = now() WHERE id = $1', [reviewId, newId]);
    await log(client, reviewId, actorId, 'Reviewer', r.reviewer_email, email);
    return { ok: true, cycleId: r.cycle_id };
  });
}

export async function removeReview(reviewId) {
  return tx(async (client) => {
    const r = (await client.query(
      'SELECT r.status, r.cycle_id, c.status AS cycle_status FROM reviews r JOIN cycles c ON c.id = r.cycle_id WHERE r.id = $1 FOR UPDATE OF r',
      [reviewId],
    )).rows[0];
    if (!r) return { ok: false, error: 'This review no longer exists.' };
    if (r.cycle_status === 'released') return { ok: false, error: 'This review can no longer be removed.', cycleId: r.cycle_id };
    if (r.status === 'submitted') return { ok: false, error: 'Submitted reviews cannot be removed. Reopen it first.', cycleId: r.cycle_id };
    await client.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
    return { ok: true, cycleId: r.cycle_id };
  });
}

export async function reopenReview(reviewId, actorId) {
  return tx(async (client) => {
    const r = (await client.query(
      'SELECT r.status, c.status AS cycle_status FROM reviews r JOIN cycles c ON c.id = r.cycle_id WHERE r.id = $1 FOR UPDATE OF r',
      [reviewId],
    )).rows[0];
    if (!r || r.cycle_status !== 'open' || r.status !== 'submitted') return { ok: false, error: 'Only submitted reviews in an open cycle can be reopened.' };
    await client.query("UPDATE reviews SET status = 'draft', submitted_at = NULL, updated_at = now() WHERE id = $1", [reviewId]);
    await log(client, reviewId, actorId, 'Reopened for the manager', null, null);
    return { ok: true };
  });
}

export async function cycleSummary(cycleId) {
  const cycle = await one('SELECT * FROM cycles WHERE id = $1', [cycleId]);
  if (!cycle) return null;
  const departments = await many(
    `SELECT d.*, u.name AS head_name, u.email AS head_email
       FROM cycle_departments d LEFT JOIN users u ON u.id = d.head_user_id
      WHERE d.cycle_id = $1 ORDER BY d.name`,
    [cycleId],
  );
  return { cycle, departments };
}
