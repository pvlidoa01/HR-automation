// Suggests a level from the behaviour checklist. Rule confirmed by Daria (HR), 26 Nov 2026:
//   - Any Poor behaviour answered Yes -> Poor.
//   - Then go through the levels from Basic up, statement by statement, and stop at the first No:
//       the FIRST statement of a level is No  -> the level below (first Basic statement No -> Poor);
//       a LATER statement of a level is No    -> that level.
//     Every statement Yes up to the top -> Exceptional.
//   - An unanswered statement stops the walk too: the suggestion is the level reached so far
//     (none yet if the first Basic statement is unanswered).
// The manager can always change the suggested rating.

import { LEVEL_KEYS } from './framework.js';

const VALUE = { POOR: 1, BASIC: 2, INTERMEDIATE: 3, ADVANCED: 4, EXCEPTIONAL: 5 };

/**
 * @param {Record<string, string[]>} statements  statements per level key
 * @param {Record<string, Record<string, 'yes'|'no'>>} answers  answers[levelKey][index]
 * @returns {number|null} suggested level 1-5, or null when there is not enough to go on
 */
export function suggestLevel(statements, answers) {
  if (!statements) return null;
  const a = answers || {};
  const answerOf = (level, i) => (a[level] ? a[level][i] ?? a[level][String(i)] : undefined);
  const list = (level) => statements[level] || [];

  if (list('POOR').some((_, i) => answerOf('POOR', i) === 'yes')) return 1;
  const anyAnswered = LEVEL_KEYS.some((lvl) => list(lvl).some((_, i) => answerOf(lvl, i) != null));
  if (!anyAnswered) return null;

  let level = 1;
  for (const lvl of ['BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXCEPTIONAL']) {
    const items = list(lvl);
    if (!items.length) continue; // a skill without statements at this level
    const first = answerOf(lvl, 0);
    if (first !== 'yes') return first == null && level === 1 ? null : level;
    level = VALUE[lvl];
    for (let i = 1; i < items.length; i += 1) {
      if (answerOf(lvl, i) !== 'yes') return level;
    }
  }
  return level;
}

export function hasChecklist(statements) {
  return !!statements && LEVEL_KEYS.some((lvl) => (statements[lvl] || []).length > 0);
}
