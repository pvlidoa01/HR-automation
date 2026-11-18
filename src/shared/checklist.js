// Suggests a level from the behaviour checklist (Notion help sheet + decisions):
//   - Poor if ANY Poor behaviour is answered Yes, or if EVERY Basic statement is answered No.
//   - Otherwise start at Basic and move up one level at a time while every statement
//     in the next level is answered Yes. The first level that is not fully Yes stops it.
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

  const poor = list('POOR');
  if (poor.some((_, i) => answerOf('POOR', i) === 'yes')) return 1;

  const basic = list('BASIC');
  if (basic.length && basic.every((_, i) => answerOf('BASIC', i) === 'no')) return 1;

  const anyAnswered = LEVEL_KEYS.some((lvl) => list(lvl).some((_, i) => answerOf(lvl, i) != null));
  if (!anyAnswered) return null;

  // Basic is the floor once no Poor behaviour applies and Basic isn't all No.
  let level = 2;
  const basicAllYes = basic.length > 0 && basic.every((_, i) => answerOf('BASIC', i) === 'yes');
  if (!basicAllYes) return level;
  for (const lvl of ['INTERMEDIATE', 'ADVANCED', 'EXCEPTIONAL']) {
    const items = list(lvl);
    if (!items.length) break;
    if (items.every((_, i) => answerOf(lvl, i) === 'yes')) level = VALUE[lvl];
    else break;
  }
  return level;
}

export function hasChecklist(statements) {
  return !!statements && LEVEL_KEYS.some((lvl) => (statements[lvl] || []).length > 0);
}
