// Automatic emails. Every email is recorded in email_outbox (HR → Emails shows them).
// They are only sent once email sending is set up (Microsoft sign-in secrets + MAIL_FROM, and IT has
// allowed the app to send mail from that mailbox). Until then they are recorded as "not sent".
// Emails never contain ratings, feedback or HR action points: only who did what, and a link.
import { query, many, one } from './db.js';
import { config } from './config.js';

export const EMAIL_KINDS = {
  review_submitted: 'A manager submits a review: their own manager is asked to confirm or adjust it',
  review_closed: 'A review is completed: HR admins are told',
  change_requested: 'Someone asks HR to reopen a review: HR admins get the request and the explanation',
  change_decided: 'HR approves or declines a request: the person who asked is told',
  review_reopened: 'HR reopens a review: its manager (and second level, if any) are told',
  cycle_initiated: 'HR initiates a cycle: every manager gets their list of reviews and the deadline',
  cycle_released: 'HR releases a cycle: every employee is told their review is available',
};

export async function getEmailSettings() {
  const row = await one("SELECT value FROM app_settings WHERE key = 'emails'");
  const saved = row?.value || {};
  return Object.fromEntries(Object.keys(EMAIL_KINDS).map((k) => [k, saved[k] !== false]));
}

export async function saveEmailSettings(values) {
  const clean = Object.fromEntries(Object.keys(EMAIL_KINDS).map((k) => [k, !!values[k]]));
  await query(
    "INSERT INTO app_settings (key, value) VALUES ('emails', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(clean)],
  );
}

export function emailSendingEnabled() {
  return config.microsoftEnabled && !!config.mailFrom;
}

const link = (p) => `${config.baseUrl}${p}`;
const isTestAddress = (email) => /\.test$/i.test(email);

/** Records an email and sends it in the background when sending is set up. */
export async function queueEmail(kind, to, subject, body) {
  if (!to?.email) return;
  const settings = await getEmailSettings();
  let status = 'not_sent';
  let error = null;
  if (settings[kind] === false) status = 'off';
  else if (isTestAddress(to.email)) error = 'Test address: never sent.';
  else if (emailSendingEnabled()) status = 'pending';
  else error = 'Email sending is not set up yet.';
  const text = `Hello ${to.name ? to.name.split(' ')[0] : ''},\n\n${body}\n\nR3 Performance Review`;
  const row = await one(
    `INSERT INTO email_outbox (kind, to_email, to_name, subject, body, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [kind, to.email, to.name || null, subject, text, status, error],
  );
  if (status === 'pending') {
    setImmediate(() => {
      sendViaGraph(to.email, subject, text)
        .then(() => query("UPDATE email_outbox SET status = 'sent', sent_at = now() WHERE id = $1", [row.id]))
        .catch((err) => query("UPDATE email_outbox SET status = 'failed', error = $2 WHERE id = $1", [row.id, String(err.message).slice(0, 500)]))
        .catch((err) => console.error('Email log update failed:', err));
    });
  }
}

let tokenCache = null;
async function graphToken() {
  if (tokenCache && tokenCache.expires > Date.now() + 60000) return tokenCache.token;
  const { tenantId, clientId, clientSecret } = config.microsoft;
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token request failed (${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function sendViaGraph(toEmail, subject, text) {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mailFrom)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: toEmail } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft sendMail failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

async function hrAdmins() {
  return many("SELECT email, name FROM users WHERE global_role = 'hr_admin' ORDER BY name");
}

async function reviewPeople(reviewId) {
  return one(
    `SELECT r.id, r.cycle_id, c.name AS cycle_name, e.name AS employee_name,
            m.id AS reviewer_id, m.name AS reviewer_name, m.email AS reviewer_email,
            s.name AS confirmer_name, s.email AS confirmer_email
       FROM reviews r
       JOIN cycles c ON c.id = r.cycle_id
       JOIN users e ON e.id = r.employee_id
       JOIN users m ON m.id = r.reviewer_id
       LEFT JOIN reviews mr ON mr.cycle_id = r.cycle_id AND mr.employee_id = r.reviewer_id
       LEFT JOIN users s ON s.id = mr.reviewer_id AND s.global_role IS DISTINCT FROM 'viewer_all'
      WHERE r.id = $1`,
    [reviewId],
  );
}

// ---- The triggers ----

export async function notifySubmitted(reviewId, step) {
  const p = await reviewPeople(reviewId);
  if (!p) return;
  if (step === 'reviewer' && p.confirmer_email) {
    await queueEmail('review_submitted', { email: p.confirmer_email, name: p.confirmer_name },
      `Please confirm: ${p.employee_name}'s review (${p.cycle_name})`,
      `${p.reviewer_name} has submitted the review of ${p.employee_name}.\n\n`
      + `Please read it and confirm it, or adjust it first. It becomes final once you confirm.\n\n${link(`/reviews/${p.id}`)}`);
    return;
  }
  // Closed: either the second level confirmed, or there is no second level.
  for (const hr of await hrAdmins()) {
    await queueEmail('review_closed', hr,
      `Review completed: ${p.employee_name} (${p.cycle_name})`,
      `The review of ${p.employee_name} is complete${step === 'confirmer' ? ` (written by ${p.reviewer_name}, confirmed by ${p.confirmer_name})` : ` (written by ${p.reviewer_name})`}.\n\n${link(`/reviews/${p.id}`)}`);
  }
}

export async function notifyChangeRequested(reviewId, requester, reason) {
  const p = await reviewPeople(reviewId);
  if (!p) return;
  for (const hr of await hrAdmins()) {
    await queueEmail('change_requested', hr,
      `Request to reopen: ${p.employee_name}'s review (${p.cycle_name})`,
      `${requester.name} asks to reopen the review of ${p.employee_name}.\n\nTheir explanation:\n${reason}\n\n`
      + `Approve or decline it here: ${link('/hr/requests')}`);
  }
}

export async function notifyChangeDecided(reviewId, requester, approved, note) {
  const p = await reviewPeople(reviewId);
  if (!p || !requester) return;
  await queueEmail('change_decided', requester,
    `${approved ? 'Reopened' : 'Not reopened'}: ${p.employee_name}'s review (${p.cycle_name})`,
    (approved
      ? `HR has reopened the review of ${p.employee_name}. You can change it now and submit it again.`
      : `HR has declined your request to reopen the review of ${p.employee_name}.`)
    + (note ? `\n\nNote from HR:\n${note}` : '') + `\n\n${link(`/reviews/${p.id}`)}`);
}

export async function notifyReopened(reviewId, { skipEmail } = {}) {
  const p = await reviewPeople(reviewId);
  if (!p) return;
  const people = [{ email: p.reviewer_email, name: p.reviewer_name }];
  if (p.confirmer_email) people.push({ email: p.confirmer_email, name: p.confirmer_name });
  for (const to of people) {
    if (to.email === skipEmail) continue; // they already get the "request approved" email
    await queueEmail('review_reopened', to,
      `Reopened: ${p.employee_name}'s review (${p.cycle_name})`,
      `HR has reopened the review of ${p.employee_name}. ${p.reviewer_name} can change it and submit it again`
      + `${p.confirmer_name ? `, then ${p.confirmer_name} confirms it` : ''}.\n\n${link(`/reviews/${p.id}`)}`);
  }
}

export async function notifyInitiated(cycleId) {
  const cycle = await one('SELECT name, deadline FROM cycles WHERE id = $1', [cycleId]);
  const managers = await many(
    `SELECT m.email, m.name, count(*)::int AS n FROM reviews r JOIN users m ON m.id = r.reviewer_id
      WHERE r.cycle_id = $1 GROUP BY m.id ORDER BY m.name`,
    [cycleId],
  );
  const due = cycle.deadline ? new Date(cycle.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  for (const m of managers) {
    await queueEmail('cycle_initiated', m,
      `Performance reviews ${cycle.name}: ${m.n} to write`,
      `The ${cycle.name} review cycle has started. You have ${m.n} review${m.n === 1 ? '' : 's'} to write`
      + `${due ? `, due ${due}` : ''}.\n\nSign in with your Microsoft work account: ${link('/team')}`);
  }
}

export async function notifyReleased(cycleId) {
  const cycle = await one('SELECT name FROM cycles WHERE id = $1', [cycleId]);
  const employees = await many(
    'SELECT r.id, e.email, e.name FROM reviews r JOIN users e ON e.id = r.employee_id WHERE r.cycle_id = $1 ORDER BY e.name',
    [cycleId],
  );
  for (const e of employees) {
    await queueEmail('cycle_released', e,
      `Your performance review is available (${cycle.name})`,
      `Your review for ${cycle.name} is now available. Please read it and mark it as read; you can also leave a comment.\n\n${link(`/reviews/${e.id}`)}`);
  }
}

/** Runs a notification without letting an email problem break the page. */
export function safely(promise) {
  return promise.catch((err) => console.error('Notification failed:', err));
}
