// Writes templates/review-cycle-template.xlsx using the Notion skill list (no database needed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTemplate } from '../src/template.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skills = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'seed', 'skills.json'), 'utf8'))
  .sort((a, b) => Number(a.draft) - Number(b.draft) || a.name.localeCompare(b.name))
  .map((s) => s.name);
const out = path.join(here, '..', 'templates', 'review-cycle-template.xlsx');
fs.writeFileSync(out, Buffer.from(await buildTemplate(skills)));
console.log(`Wrote ${out}`);
