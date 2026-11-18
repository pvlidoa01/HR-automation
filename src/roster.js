// Reading and checking the employee list HR uploads for a cycle.
//
// Excel template (scripts/make-template.js):
//   Sheet "Employees":   Employee name | Employee email | Department | Position | Seniority |
//                        Reviewer name | Reviewer email | Skill 1 | Skill 2 | Skill 3
//   Sheet "Departments": Department | Head name | Head email
import ExcelJS from 'exceljs';
import { SENIORITIES } from './shared/framework.js';

export const EMPLOYEE_COLUMNS = [
  { key: 'employeeName', header: 'Employee name' },
  { key: 'employeeEmail', header: 'Employee email' },
  { key: 'department', header: 'Department' },
  { key: 'position', header: 'Position' },
  { key: 'seniority', header: 'Seniority' },
  { key: 'reviewerName', header: 'Reviewer name' },
  { key: 'reviewerEmail', header: 'Reviewer email' },
  { key: 'skill1', header: 'Skill 1' },
  { key: 'skill2', header: 'Skill 2' },
  { key: 'skill3', header: 'Skill 3' },
];
export const DEPARTMENT_COLUMNS = [
  { key: 'department', header: 'Department' },
  { key: 'headName', header: 'Head name' },
  { key: 'headEmail', header: 'Head email' },
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
    const match = columns.find((c) => key(c.header) === h);
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

/** Parses the uploaded workbook. Returns { employees, departments, fileErrors }. */
export async function parseRoster(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    return { employees: [], departments: [], fileErrors: ["This file can't be read. Upload the .xlsx template filled in."] };
  }
  const fileErrors = [];
  const findSheet = (name) => wb.worksheets.find((s) => key(s.name) === key(name));
  const empSheet = findSheet('Employees') || wb.worksheets[0];
  if (!empSheet) return { employees: [], departments: [], fileErrors: ['The file has no sheets.'] };
  const emp = readSheet(empSheet, EMPLOYEE_COLUMNS);
  if (emp.missing.length) fileErrors.push(`Sheet "${empSheet.name}" is missing these columns: ${emp.missing.join(', ')}.`);
  let departments = [];
  const depSheet = findSheet('Departments');
  if (depSheet) {
    const dep = readSheet(depSheet, DEPARTMENT_COLUMNS);
    if (dep.missing.length) fileErrors.push(`Sheet "Departments" is missing these columns: ${dep.missing.join(', ')}.`);
    departments = dep.rows;
  } else {
    fileErrors.push('The sheet "Departments" is missing. Add it to name a head for each department.');
  }
  if (!fileErrors.length && !emp.rows.length) fileErrors.push('The Employees sheet has no rows.');
  return { employees: emp.rows, departments, fileErrors };
}

/**
 * Checks parsed rows. `skillNames` is the current skill list.
 * Returns rows annotated with errors/warnings, plus summary lists.
 */
export function validateRoster({ employees, departments }, skillNames) {
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
    if (!r.reviewerName) errors.push('Reviewer name is missing.');
    if (!reviewerEmail) errors.push('Reviewer email is missing.');
    else if (!EMAIL_RE.test(reviewerEmail)) errors.push(`"${r.reviewerEmail}" is not a valid email.`);
    if (email && reviewerEmail && email === reviewerEmail) errors.push('An employee cannot be their own reviewer.');
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

  const usedDepartments = new Map();
  for (const r of rows) if (r.department && !usedDepartments.has(key(r.department))) usedDepartments.set(key(r.department), r.department);

  const departmentErrors = [];
  const departmentWarnings = [];
  const heads = new Map();
  const listedDepartments = new Set();
  for (const d of departments) {
    if (!d.department) continue;
    const k = key(d.department);
    const headEmail = d.headEmail.toLowerCase();
    if (listedDepartments.has(k)) {
      departmentErrors.push(`Department "${d.department}" is listed twice in the Departments sheet.`);
      continue;
    }
    listedDepartments.add(k);
    if (!usedDepartments.has(k)) {
      departmentWarnings.push(`Department "${d.department}" in the Departments sheet has no employees in this cycle. It is ignored.`);
      continue;
    }
    if (headEmail && !EMAIL_RE.test(headEmail)) {
      departmentErrors.push(`Head email "${d.headEmail}" for "${d.department}" is not valid.`);
      continue;
    }
    if (headEmail && !d.headName) {
      departmentErrors.push(`Head name for "${d.department}" is missing.`);
      continue;
    }
    if (headEmail) {
      heads.set(k, { name: usedDepartments.get(k), headName: d.headName, headEmail });
      if (namesByEmail.has(headEmail) && key(namesByEmail.get(headEmail)) !== key(d.headName)) {
        departmentWarnings.push(`${headEmail} appears with two names. "${namesByEmail.get(headEmail)}" is used.`);
      } else if (!namesByEmail.has(headEmail)) namesByEmail.set(headEmail, d.headName);
    }
  }
  const departmentList = [...usedDepartments.entries()].map(([k, name]) => {
    const h = heads.get(k);
    if (!h) departmentWarnings.push(`"${name}" has no department head. Only the managers, HR and the CEO will see its reviews.`);
    return { name, headName: h?.headName || null, headEmail: h?.headEmail || null };
  });

  const errorCount = rows.reduce((n, r) => n + r.errors.length, 0) + departmentErrors.length;
  return {
    rows,
    departments: departmentList,
    departmentErrors,
    departmentWarnings,
    newSkills: [...newSkills.values()],
    namesByEmail,
    errorCount,
  };
}
