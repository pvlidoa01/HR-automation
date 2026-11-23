// Live checklist suggestions and grades on the review form.
// Uses the same rule code as the server (/shared/*.js).
import { suggestLevel } from '/shared/checklist.js';
import { computeGrades, gradeLabel } from '/shared/scoring.js';
import { levelLabel, LEVEL_KEYS } from '/shared/framework.js';

const form = document.getElementById('review-form');
const data = JSON.parse(document.getElementById('review-data').textContent);
let dirty = false;

function badge(code) {
  const span = document.createElement('span');
  span.className = `badge grade-${code || 'none'}`;
  span.textContent = gradeLabel(code);
  return span;
}

function readAnswers(dimKey) {
  const answers = {};
  for (const lvl of LEVEL_KEYS) {
    form.querySelectorAll(`input[name^="chk[${dimKey}][${lvl}]"]:checked`).forEach((input) => {
      const idx = input.name.match(/\[(\d+)\]$/)[1];
      answers[lvl] = answers[lvl] || {};
      answers[lvl][idx] = input.value;
    });
  }
  return answers;
}

function updateGrades() {
  const ratings = {};
  form.querySelectorAll('select[data-rating]').forEach((sel) => {
    const key = sel.name.match(/^rating\[(.+)\]$/)[1];
    ratings[key] = sel.value === '' ? null : Number(sel.value);
  });
  const g = computeGrades(ratings, data.seniority, data.bar);
  document.querySelectorAll('[data-area-grade]').forEach((el) => {
    el.replaceChildren(badge(g.areas[el.dataset.areaGrade]));
  });
  document.querySelectorAll('[data-overall]').forEach((el) => el.replaceChildren(badge(g.overall)));
  document.querySelectorAll('section.dim').forEach((section) => {
    const d = g.dimensions[section.dataset.dim];
    const el = section.querySelector('[data-diff]');
    if (!el) return;
    el.className = 'diff ' + (d.diff == null ? '' : d.diff > 0 ? 'pos' : d.diff === 0 ? 'zero' : 'neg');
    el.textContent = d.diff == null ? '' : d.diff > 0 ? `+${d.diff}` : `${d.diff}`;
  });
}

// The rating follows the checklist ("auto") unless someone picked a different level by hand.
// This also holds for a review opened again later, e.g. by the second level, HR or the CEO:
// a saved rating that matches the saved checklist keeps following it when statements change.
function updateSuggestion(section, fromChecklist) {
  const key = section.dataset.dim;
  const statements = data.statements[key];
  const out = section.querySelector('[data-suggestion]');
  if (!statements || !out) return;
  const level = suggestLevel(statements, readAnswers(key));
  const select = section.querySelector('select[data-rating]');
  if (level == null) {
    out.textContent = 'Answer the statements to get a suggested level.';
    return;
  }
  if (fromChecklist && select && (select.value === '' || select.dataset.auto === '1')) {
    select.value = String(level);
    select.dataset.auto = '1';
  }
  out.textContent = `Suggested level: ${level} · ${levelLabel(level)}`;
  if (select && select.value !== '' && Number(select.value) !== level) {
    out.append(` (rating set by hand to ${select.value} · ${levelLabel(Number(select.value))}) `);
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn small';
    use.textContent = `Use ${level} · ${levelLabel(level)}`;
    use.addEventListener('click', () => {
      select.value = String(level);
      select.dataset.auto = '1';
      dirty = true;
      updateSuggestion(section, false);
      updateGrades();
    });
    out.append(use);
  }
}

form.addEventListener('change', (e) => {
  dirty = true;
  const section = e.target.closest('section.dim');
  if (e.target.matches('select[data-rating]')) {
    e.target.dataset.auto = '0';
    if (section) updateSuggestion(section, false);
  } else if (e.target.matches('input[type=radio]') && section) {
    updateSuggestion(section, true);
  }
  updateGrades();
});
form.addEventListener('input', () => { dirty = true; });
form.addEventListener('submit', () => { dirty = false; });
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// On opening: a saved rating that equals what the saved checklist suggests follows the checklist.
document.querySelectorAll('section.dim').forEach((section) => {
  const select = section.querySelector('select[data-rating]');
  const statements = data.statements[section.dataset.dim];
  if (select && statements) {
    const level = suggestLevel(statements, readAnswers(section.dataset.dim));
    select.dataset.auto = select.value === '' || (level != null && Number(select.value) === level) ? '1' : '0';
  }
  updateSuggestion(section, false);
});
updateGrades();
