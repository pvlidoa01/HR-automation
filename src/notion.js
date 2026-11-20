// "Update skills from Notion": reads the Notion Skill Base and updates the app's copy of each
// skill's questionnaire. Notion stays the only place where questions are written.
//
// Each skill is a page in the Skill Base database:
//   - title: the skill name; "DRAFT " in front marks a draft skill
//   - a callout under the "Definition" heading: the short definition (may be empty)
//   - a table with two columns, Level | Behavior, one row per statement
//     (POOR, BASIC, INTERMEDIATE, ADVANCED, EXCEPTIONAL; a level can have several rows)
//
// Changes only reach cycles initiated afterwards: running and past cycles keep the questionnaire
// they started with (cycle_skills), because checklist answers are stored by statement position.
import { config } from './config.js';
import { many, tx } from './db.js';
import { LEVEL_KEYS } from './shared/framework.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

export const notionConfigured = () => !!config.notion.token;

async function call(path, { method = 'GET', body } = {}, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.notion.token}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (res.status === 401) throw new Error('Notion refused the key (NOTION_TOKEN). Check that it was copied correctly.');
      if (res.status === 404) throw new Error('Notion could not find the Skill Base. Share the Skill Base database with the app\'s Notion connection, and check NOTION_SKILL_BASE_ID.');
      throw new Error(`Notion error ${res.status}: ${text}`);
    }
    return res.json();
  }
  throw new Error('Notion is busy (too many requests). Try again in a minute.');
}

async function allChildren(blockId, fetchImpl) {
  const out = [];
  let cursor;
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (cursor) q.set('start_cursor', cursor);
    const data = await call(`/blocks/${blockId}/children?${q}`, {}, fetchImpl);
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

const plain = (richText) => (richText || []).map((t) => t.plain_text || '').join('');
export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase();

/** Turns one skill page (its title and blocks) into { name, draft, definition, levels, problems }. */
export async function readSkillPage(page, fetchImpl = fetch) {
  const titleProp = Object.values(page.properties || {}).find((p) => p.type === 'title');
  const rawTitle = clean(plain(titleProp?.title));
  const draft = /^draft\b/i.test(rawTitle);
  const name = clean(rawTitle.replace(/^draft\b[\s:–-]*/i, ''));
  const problems = [];

  const blocks = await allChildren(page.id, fetchImpl);
  let heading = '';
  let definition = null;
  let table = null;
  // Also look one level down (toggles, columns), in case a page is laid out differently.
  const queue = blocks.map((b) => ({ b, depth: 0 }));
  while (queue.length) {
    const { b, depth } = queue.shift();
    if (/^heading_/.test(b.type)) heading = clean(plain(b[b.type].rich_text)).toLowerCase();
    if (b.type === 'callout' && definition === null && heading.includes('definition')) {
      const parts = [plain(b.callout.rich_text)];
      if (b.has_children) {
        for (const c of await allChildren(b.id, fetchImpl)) if (c[c.type]?.rich_text) parts.push(plain(c[c.type].rich_text));
      }
      definition = clean(parts.join(' ')) || null;
    }
    if (b.type === 'table' && !table) table = b;
    if (!table && b.has_children && depth < 1 && ['toggle', 'column_list', 'column', 'synced_block'].includes(b.type)) {
      for (const c of await allChildren(b.id, fetchImpl)) queue.push({ b: c, depth: depth + 1 });
    }
  }

  const levels = {};
  if (!table) {
    problems.push('No Level / Behavior table found on the page.');
  } else {
    const rows = (await allChildren(table.id, fetchImpl)).filter((r) => r.type === 'table_row');
    const body = table.table?.has_column_header ? rows.slice(1) : rows;
    let previous = null;
    body.forEach((row, i) => {
      const [levelCell, textCell] = row.table_row.cells.map((c) => clean(plain(c)));
      const level = levelCell.toUpperCase().replace(/[^A-Z]/g, '');
      if (!textCell) return; // empty row
      let key = LEVEL_KEYS.includes(level) ? level : null;
      if (!levelCell && previous) {
        key = previous;
        problems.push(`Row ${i + 1} has no level; counted under ${previous}.`);
      } else if (!key) {
        problems.push(`Row ${i + 1} has an unknown level "${levelCell}"; left out.`);
        return;
      }
      (levels[key] ||= []).push(textCell);
      previous = key;
    });
    if (!Object.keys(levels).length) problems.push('The table has no statements.');
  }
  return { pageId: normId(page.id), name, draft, definition, levels, editedAt: page.last_edited_time || null, url: page.url, problems };
}

/** Reads every skill in the Skill Base. */
export async function readSkillBase(fetchImpl = fetch) {
  const pages = [];
  let cursor;
  do {
    const data = await call(`/databases/${config.notion.skillBaseId}/query`, {
      method: 'POST',
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    }, fetchImpl);
    pages.push(...data.results.filter((p) => p.object === 'page' && !p.archived && !p.in_trash));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  const skills = [];
  for (const p of pages) skills.push(await readSkillPage(p, fetchImpl));
  return skills;
}

const sameLevels = (a, b) => JSON.stringify(LEVEL_KEYS.map((k) => a?.[k] || [])) === JSON.stringify(LEVEL_KEYS.map((k) => b?.[k] || []));

/**
 * Compares Notion with the app. Returns a list of changes to show HR before applying:
 * { kind: 'new'|'update'|'same'|'problem'|'missing', notion, app, what[] }
 */
export async function planSkillSync(notionSkills) {
  const appSkills = await many('SELECT id, name, definition, levels, draft, notion_page_id FROM skills ORDER BY name');
  const byPage = new Map(appSkills.filter((s) => s.notion_page_id).map((s) => [s.notion_page_id, s]));
  const byName = new Map(appSkills.map((s) => [s.name.toLowerCase(), s]));
  const seen = new Set();
  const names = new Set();
  const plan = [];
  for (const n of notionSkills) {
    const app = byPage.get(n.pageId) || byName.get(n.name.toLowerCase()) || null;
    if (app) seen.add(app.id);
    const statements = LEVEL_KEYS.reduce((sum, k) => sum + (n.levels[k]?.length || 0), 0);
    if (!n.name) { plan.push({ kind: 'problem', notion: n, app, what: ['The page has no title.'] }); continue; }
    if (names.has(n.name.toLowerCase())) { plan.push({ kind: 'problem', notion: n, app, what: [`Two Notion pages are called "${n.name}".`] }); continue; }
    names.add(n.name.toLowerCase());
    if (!statements) { plan.push({ kind: 'problem', notion: n, app, what: n.problems }); continue; }
    const clash = byName.get(n.name.toLowerCase());
    if (app && clash && clash.id !== app.id) {
      plan.push({ kind: 'problem', notion: n, app, what: [`Renaming to "${n.name}" clashes with another skill in the app.`] });
      continue;
    }
    if (!app) { plan.push({ kind: 'new', notion: n, app: null, what: [`New skill with ${statements} statements`], warnings: n.problems }); continue; }
    const what = [];
    if (app.name !== n.name) what.push(`Renamed from "${app.name}"`);
    if (!sameLevels(app.levels, n.levels)) what.push('Questionnaire changed');
    if ((app.definition || null) !== (n.definition || null)) what.push('Definition changed');
    if (app.draft !== n.draft) what.push(n.draft ? 'Now marked as draft' : 'No longer a draft');
    if (app.notion_page_id !== n.pageId && !what.length) {
      plan.push({ kind: 'same', notion: n, app, what: [], link: true });
      continue;
    }
    plan.push({ kind: what.length ? 'update' : 'same', notion: n, app, what, warnings: n.problems, link: app.notion_page_id !== n.pageId });
  }
  for (const s of appSkills) {
    if (!seen.has(s.id) && s.notion_page_id) plan.push({ kind: 'missing', notion: null, app: s, what: ['No longer in the Notion Skill Base. Kept in the app.'] });
  }
  const order = { new: 0, update: 1, problem: 2, missing: 3, same: 4 };
  plan.sort((a, b) => order[a.kind] - order[b.kind] || (a.notion?.name || a.app.name).localeCompare(b.notion?.name || b.app.name));
  return plan;
}

/** Applies the new and updated skills of a plan. Returns how many skills changed. */
export async function applySkillSync(plan) {
  return tx(async (client) => {
    let changed = 0;
    for (const p of plan) {
      const n = p.notion;
      if (p.kind === 'new') {
        await client.query(
          `INSERT INTO skills (name, definition, levels, source, draft, notion_page_id, notion_edited_at, updated_at)
           VALUES ($1, $2, $3, 'notion', $4, $5, $6, now())`,
          [n.name, n.definition, JSON.stringify(n.levels), n.draft, n.pageId, n.editedAt],
        );
        changed += 1;
      } else if (p.kind === 'update' || (p.kind === 'same' && p.link)) {
        await client.query(
          `UPDATE skills SET name = $2, definition = $3, levels = $4, draft = $5, notion_page_id = $6,
                  notion_edited_at = $7, updated_at = CASE WHEN $8 THEN now() ELSE updated_at END, source = 'notion'
            WHERE id = $1`,
          [p.app.id, n.name, n.definition, JSON.stringify(n.levels), n.draft, n.pageId, n.editedAt, p.kind === 'update'],
        );
        if (p.kind === 'update') changed += 1;
      }
    }
    return changed;
  });
}
