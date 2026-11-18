// Builds the Excel template HR fills in for a cycle.
import ExcelJS from 'exceljs';
import { EMPLOYEE_COLUMNS, DEPARTMENT_COLUMNS } from './roster.js';
import { SENIORITIES } from './shared/framework.js';

export async function buildTemplate(skillNames) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'R3 Performance Review';

  const help = wb.addWorksheet('How to fill in');
  help.getColumn(1).width = 110;
  [
    'How to fill in this file',
    '',
    'Employees sheet: one row per person reviewed in this cycle.',
    '  - Employee email and Reviewer email must be their Microsoft work emails; that is how people sign in.',
    '  - Seniority: Junior, Mid, Senior, Lead, Head or VP (pick from the dropdown).',
    '  - Skill 1, 2 and 3: pick from the dropdown. Skill 1 is the most important one (it has a higher bar for Senior and Head).',
    '    A skill name that is not in the list is added to the app as a new skill when you upload.',
    '',
    'Departments sheet: one row per department, with the head who can read that department\'s reviews.',
    '  - Use exactly the same department names as in the Employees sheet.',
    '',
    'Upload the file on the cycle\'s set-up page. The app shows any problems before anything is saved.',
  ].forEach((line, i) => {
    help.getCell(`A${i + 1}`).value = line;
  });
  help.getRow(1).font = { bold: true, size: 14 };

  const emp = wb.addWorksheet('Employees', { views: [{ state: 'frozen', ySplit: 1 }] });
  emp.columns = EMPLOYEE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.key.startsWith('skill') ? 34 : 24 }));

  const dep = wb.addWorksheet('Departments', { views: [{ state: 'frozen', ySplit: 1 }] });
  dep.columns = DEPARTMENT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 28 }));

  const lists = wb.addWorksheet('Lists');
  lists.getColumn(1).width = 14;
  lists.getColumn(2).width = 48;
  lists.getCell('A1').value = 'Seniority';
  lists.getCell('B1').value = 'Skills in the app (new names are added on upload)';
  SENIORITIES.forEach((s, i) => { lists.getCell(`A${i + 2}`).value = s; });
  skillNames.forEach((s, i) => { lists.getCell(`B${i + 2}`).value = s; });

  for (const ws of [emp, dep, lists]) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F6' } };
  }

  const seniorityRange = `Lists!$A$2:$A$${SENIORITIES.length + 1}`;
  const skillRange = `Lists!$B$2:$B$${Math.max(skillNames.length + 1, 2)}`;
  for (let row = 2; row <= 300; row += 1) {
    emp.getCell(`E${row}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: [seniorityRange],
      showErrorMessage: true, errorTitle: 'Seniority', error: `Pick one of: ${SENIORITIES.join(', ')}`,
    };
    for (const col of ['H', 'I', 'J']) {
      // Warning only, so HR can type a new skill name.
      emp.getCell(`${col}${row}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [skillRange],
        showErrorMessage: true, errorStyle: 'warning', errorTitle: 'New skill?',
        error: 'This skill is not in the list. Keep it to add it as a new skill.',
      };
    }
  }
  return wb.xlsx.writeBuffer();
}
