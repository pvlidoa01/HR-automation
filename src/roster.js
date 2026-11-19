// Reading and checking the employee list HR uploads for a cycle.
//
// Excel template (src/template.js):
//   Sheet "Employees": Employee name | Employee email | Department | Position | Seniority |
//                      Manager name | Manager email | Skill 1 | Skill 2 | Skill 3
// The manager is the person's reviewer, and the reporting lines build the organisation tree.
// Managers who are not reviewed themselves (the heads) don't need a row.
import ExcelJS from 'exceljs';
import { SENIORITIES } from './shared/framework.js';
import { findLoops } from './org.js';

export const EMPLOYEE_COLUMNS = [
  { key: 'employeeName', header: 'Employee name' },
  { key: 'employeeEmail', header: 'Employee email' },
  { key: 'department', header: 'Department' },
  { key: 'position', header: 'Position' },
  { key: 'seniority', header: 'Seniority' },
  { key: 'reviewerName', header: 'Manager name', aliases: ['Reviewer name'] },
  { key: 'reviewerEmail', header: 'Manager email', aliases: ['Reviewer email'] },
  { key: 'skill1', header: 'Skill 1' },
  { key: 'skill2', header: 'Skill 2' },
  { key: 'skill3', header: 'Skill 3' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase();

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return typeof v.text === 'object' ? cellText({ value: v.text }) : String(v.text); // hyperlink
    if (v.result != null) return String(v.result); // formula
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function readSheet(sheet, columns) {
  const headerRow = sheet.getRow(1);
  const colIndex = {};
  headerRow.eachCell((cell, col) => {
    const h = key(cellText(cell));
    const match = columns.find((c) => [c.header, ...(c.aliases || [])].some((x) => key(x) === h));
    if (match) colIndex[match.key] = col;
  });
  const missing = columns.filter((c) => !colIndex[c.key]).map((c) => c.header);
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = { rowNumber };
    let any = false;
    for (const c of columns) {
      obj[c.key] = colIndex[c.key] ? norm(cellText(row.getCell(colIndex[c.key]))) : '';
      if (obj[c.key]) any = true;
    }
    if (any) rows.push(obj);
  });
  return { rows, missing };
}

/** Parses the uploaded workbook. Returns { employees, fileErrors }. */
export async function parseRoster(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    return { employees: [], fileErrors: ["This file can't be read. Upload the .xlsx template filled in."] };
  }
  const fileErrors = [];
  const empSheet = wb.worksheets.find((s) => key(s.name) === 'employees') || wb.worksheets[0];
  if (!empSheet) return { employees: [], fileErrors: ['The file has no sheets.'] };
  const emp = readSheet(empSheet, EMPLOYEE_COLUMNS);
  if (emp.missing.length) fileErrors.push(`Sheet "${empSheet.name}" is missing these columns: ${emp.missing.join(', ')}.`);
  if (!fileErrors.length && !emp.rows.length) fileErrors.push('The Employees sheet has no rows.');
  return { employees: emp.rows, fileErrors };
}

/**
 * Checks parsed rows. `skillNames` is the current skill list.
 * Returns rows annotated with errors/warnings, plus summary lists.
 */
export function validateRoster({ employees }, skillNames) {
  const known = new Map(skillNames.map((n) => [key(n), n]));
  const seenEmployees = new Map();
  const namesByEmail = new Map();
  const newSkills = new Map();
  const rows = employees.map((r) => {
    const errors = [];
    const warnings = [];
    const email = r.employeeEmail.toLowerCase();
    const reviewerEmail = r.reviewerEmail.toLowerCase();
    if (!r.employeeName) errors.push('Employee name is missing.');
    if (!email) errors.push('Employee email is missing.');
    else if (!EMAIL_RE.test(email)) errors.push(`"${r.employeeEmail}" is not a valid email.`);
    if (!r.department) errors.push('Department is missing.');
    if (!r.position) errors.push('Position is missing.');
    const seniority = SENIORITIES.find((s) => key(s) === key(r.seniority));
    if (!seniority) errors.push(`Seniority must be one of ${SENIORITIES.join(', ')}${r.seniority ? ` (found "${r.seniority}")` : ''}.`);
    if (!r.reviewerName) errors.push('Manager name is missing.');
    if (!reviewerEmail) errors.push('Manager email is missing.');
    else if (!EMAIL_RE.test(reviewerEmail)) errors.push(`"${r.reviewerEmail}" is not a valid email.`);
    if (email && reviewerEmail && email === reviewerEmail) errors.push('An employee cannot be their own manager.');
    if (email) {
      if (seenEmployees.has(email)) errors.push(`This employee is already listed in row ${seenEmployees.get(email)}.`);
      else seenEmployees.set(email, r.rowNumber);
    }
    const skills = [r.skill1, r.skill2, r.skill3].map((s, i) => {
      if (!s) {
        errors.push(`Skill ${i + 1} is missing.`);
        return null;
      }
      const existing = known.get(key(s));
      if (existing) return existing;
      if (!newSkills.has(key(s))) newSkills.set(key(s), s);
      warnings.push(`"${s}" is not in the skill list yet. It will be added.`);
      return s;
    });
    const filled = skills.filter(Boolean).map(key);
    if (new Set(filled).size !== filled.length) errors.push('The same skill is listed twice.');
    for (const [e, n] of [[email, r.employeeName], [reviewerEmail, r.reviewerName]]) {
      if (!e || !n) continue;
      if (namesByEmail.has(e) && key(namesByEmail.get(e)) !== key(n)) {
        warnings.push(`${e} appears with two names ("${namesByEmail.get(e)}" and "${n}"). The first one is used.`);
      } else if (!namesByEmail.has(e)) namesByEmail.set(e, n);
    }
    return {
      ...r,
      employeeEmail: email,
      reviewerEmail,
      seniority: seniority || r.seniority,
      skills,
      errors,
      warnings,
    };
  });

  // Reporting lines must not go round in a circle (A manages B and B manages A).
  const edges = new Map(rows.filter((r) => r.employeeEmail && r.reviewerEmail).map((r) => [r.employeeEmail, r.reviewerEmail]));
  const structureErrors = findLoops(edges).map((loop) => `Reporting lines go round in a circle: ${[...loop, loop[0]].join(' → ')}. Fix the manager of one of them.`);

  const errorCount = rows.reduce((n, r) => n + r.errors.length, 0) + structureErrors.length;
  return {
    rows,
    structureErrors,
    newSkills: [...newSkills.values()],
    namesByEmail,
    errorCount,
  };
}
