// Applies SQL migrations in /migrations once each, then seeds the skill list
// and the first HR admin. Safe to run on every start.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

export async function migrate({ quiet = false } = {}) {
  const client = await pool.connect();
  try {
    // Only one app instance migrates at a time (Autoscale can start several).
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        if (!quiet) console.log(`Applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await seedSkills(client, quiet);
    await seedHrAdmin(client, quiet);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

function notionPageId(url) {
  const m = String(url || '').match(/([0-9a-f]{32})(?:\?|$)/i);
  return m ? m[1].toLowerCase() : null;
}

async function seedSkills(client, quiet) {
  const skills = JSON.parse(fs.readFileSync(path.join(here, 'seed', 'skills.json'), 'utf8'));
  let added = 0;
  for (const s of skills) {
    const pageId = notionPageId(s.notionUrl);
    // Link skills seeded before migration 005 to their Notion page.
    if (pageId) await client.query('UPDATE skills SET notion_page_id = $2 WHERE name = $1 AND notion_page_id IS NULL', [s.name, pageId]);
    // Skip skills already present, also when "Update from Notion" has renamed them since.
    const res = await client.query(
      `INSERT INTO skills (name, definition, levels, source, draft, notion_page_id)
       SELECT $1, $2, $3, 'notion', $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = $1 OR (notion_page_id IS NOT NULL AND notion_page_id = $5))`,
      [s.name, s.definition, JSON.stringify(s.levels), s.draft, pageId],
    );
    added += res.rowCount;
  }
  if (added && !quiet) console.log(`Added ${added} skills from the Notion Skill Base`);
}

// Sets the first HR admin only while there is none, so removing or changing HR admins
// in Access settings is not undone on the next start.
async function seedHrAdmin(client, quiet) {
  if (!config.initialHrAdminEmail) return;
  const existing = await client.query("SELECT 1 FROM users WHERE global_role = 'hr_admin' LIMIT 1");
  if (existing.rowCount) return;
  const res = await client.query(
    `INSERT INTO users (email, name, global_role) VALUES ($1, $2, 'hr_admin')
     ON CONFLICT (email) DO UPDATE SET global_role = 'hr_admin'
     WHERE users.global_role IS DISTINCT FROM 'hr_admin'`,
    [config.initialHrAdminEmail, config.initialHrAdminName],
  );
  if (res.rowCount && !quiet) console.log(`HR admin set: ${config.initialHrAdminEmail}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}
