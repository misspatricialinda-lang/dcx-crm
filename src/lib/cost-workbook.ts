import type { Style } from 'exceljs';
import type { QuoteDraft, SavedQuote } from '../types/operations';
import { calculateCost, FORMULA_VERSION } from './costing.ts';
import template from './cost-template.json' with { type: 'json' };

// Layout/styles extracted from the client's XLS. Only labels are retained;
// every estimate value is populated below, so sample costs cannot leak into exports.
export async function buildCostWorkbook(draft: QuoteDraft) {
  const calc = calculateCost(draft);
  if (!calc.valid) {
    throw new Error('Correct invalid calculation inputs before exporting.');
  }
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'DCX Technical Inc.';
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const sheet = book.addWorksheet('Job Cost Sheet', {
    views: [{ state: 'frozen', ySplit: 10, showGridLines: false }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:10' },
  });
  const lineCount = Math.max(10, draft.lines.length);
  const flatCount = Math.max(2, draft.flatLines.length);
  const extraLines = lineCount - 10, extraFlats = flatCount - 2;
  const rowAt = (row: number) => row + (row >= 21 ? extraLines : 0) + (row >= 24 ? extraFlats : 0);
  const moneyFormat = '#,##0.00';
  template.widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  for (const entry of template.cells) {
    const cell = sheet.getCell(rowAt(entry.row), entry.col);
    cell.style = structuredClone(template.styles[entry.style]) as Partial<Style>;
    cell.value = entry.value;
  }
  for (const [row, height] of Object.entries(template.heights)) sheet.getRow(rowAt(Number(row))).height = height;
  for (const [top, left, bottom, right] of template.merges) sheet.mergeCells(rowAt(top), left, rowAt(bottom), right);
  const put = (address: string, value: string | number | Date | null) => { sheet.getCell(address).value = value === '' ? null : value; };
  const formula = (address: string, expression: string, result: number | string) => {
    sheet.getCell(address).value = { formula: expression, result };
  };
  const mergedText = (range: string, value: string) => {
    sheet.mergeCells(range);
    const cell = sheet.getCell(range.split(':')[0]);
    cell.value = value || null; cell.alignment = { vertical: 'middle', wrapText: true };
  };
  const saved = draft as Partial<SavedQuote>;
  mergedText('L2:M2', saved.number ? `${saved.number} / R${saved.revision || 1}` : 'Working estimate');
  mergedText('L3:M3', '');
  sheet.mergeCells('L4:M4'); put('L4', new Date()); sheet.getCell('L4').numFmt = 'yyyy-mm-dd';
  put('K5', 'Currency'); mergedText('L5:M5', 'CAD');
  put('C5', draft.customerSnapshot?.name || 'Quick calculation');
  put('A7', 'Scope:'); mergedText('C7:L7', draft.title);
  put('C8', draft.site);
  sheet.getRow(5).height = Math.max(30, Math.ceil((draft.customerSnapshot?.name.length || 17) / 55) * 16);
  sheet.getRow(7).height = Math.max(25, Math.ceil(draft.title.length / 110) * 16);
  sheet.getRow(8).height = Math.max(30, Math.ceil(draft.site.length / 110) * 16);
  sheet.getRow(10).height = 44;

  // Rebuild the entire detail area, including blank template rows, with current data.
  for (let i = 0; i < lineCount; i++) {
    const row = i + 11, line = calc.lines[i];
    for (let col = 1; col <= 13; col++) {
      const source = template.cells.find(c => c.row === 11 && c.col === col)!;
      sheet.getCell(row, col).style = structuredClone(template.styles[source.style]) as Partial<Style>;
      sheet.getCell(row, col).value = null;
    }
    sheet.getRow(row).height = line ? Math.max(32, (Math.ceil(line.description.length / 27) + (line.unit ? 1 : 0)) * 14, Math.ceil(line.supplier.length / 27) * 14) : 25;
    if (!line) continue;
    put(`A${row}`, i + 1); put(`B${row}`, line.supplier);
    put(`C${row}`, line.description + (line.unit ? `\n(${line.unit})` : ''));
    sheet.getCell(`B${row}`).alignment = { wrapText: true, vertical: 'middle' };
    put(`D${row}`, line.supplierCost); put(`E${row}`, line.multiplier);
    if (line.costMode === 'manual') put(`F${row}`, line.manualCost);
    else formula(`F${row}`, `D${row}*E${row}`, line.unitCost);
    put(`G${row}`, line.quantity); put(`I${row}`, line.exchangeRate); put(`K${row}`, line.margin);
    formula(`H${row}`, `F${row}*G${row}`, line.extendedCost);
    formula(`J${row}`, `H${row}/I${row}`, line.cadCost);
    formula(`M${row}`, `J${row}/(1-K${row})`, line.sell);
    formula(`L${row}`, `M${row}-J${row}`, line.profit);
    sheet.getCell(`K${row}`).numFmt = '0.00%';
  }
  const flatStart = rowAt(22), flatEnd = flatStart + flatCount - 1;
  sheet.mergeCells(`A${rowAt(21)}:M${rowAt(21)}`);
  for (let i = 0; i < flatCount; i++) {
    const row = flatStart + i, flat = draft.flatLines[i];
    for (let col = 1; col <= 13; col++) {
      const source = template.cells.find(c => c.row === 22 && c.col === col)!;
      sheet.getCell(row, col).style = structuredClone(template.styles[source.style]) as Partial<Style>;
      sheet.getCell(row, col).value = null;
    }
    sheet.getRow(row).height = Math.max(28, Math.ceil((flat?.description.length || 0) / 27) * 14);
    if (!flat) continue;
    put(`A${row}`, i + 1); put(`C${row}`, flat.description);
    sheet.getCell(`C${row}`).alignment = { wrapText: true, vertical: 'middle' };
    put(`D${row}`, flat.amount); put(`F${row}`, flat.addition);
    put(`G${row}`, 1);
    formula(`H${row}`, `D${row}+F${row}`, flat.amount + flat.addition);
    formula(`M${row}`, `H${row}`, flat.amount + flat.addition);
    for (const col of ['D', 'F', 'H', 'M']) sheet.getCell(`${col}${row}`).numFmt = moneyFormat;
  }
  put(`B${rowAt(26)}`, draft.notes);
  sheet.getCell(`B${rowAt(26)}`).alignment = { wrapText: true, vertical: 'top' };
  sheet.getRow(rowAt(26)).height = Math.max(30, draft.notes.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 135)), 0) * 15);
  const cost = rowAt(29), sell = rowAt(31), profit = rowAt(33);
  put(`L${cost}`, draft.shipping); put(`L${sell}`, draft.brokerage);
  formula(`E${cost}`, `SUM(J11:J${10 + lineCount})+L${cost}+L${sell}`, calc.totalCost);
  formula(`E${sell}`, `SUM(M11:M${10 + lineCount})+SUM(M${flatStart}:M${flatEnd})`, calc.sellingPrice);
  formula(`E${profit}`, `E${sell}-E${cost}`, calc.profit);
  formula(`L${profit}`, `IF(E${sell}=0,"N/A",E${profit}/E${sell})`, calc.grossMargin ?? 'N/A');
  sheet.getCell(`L${profit}`).numFmt = '0.00%';
  // Replace the original conversion strip with a CAD-only currency note.
  for (const col of ['C', 'D', 'F', 'H', 'I', 'K', 'L']) put(`${col}${rowAt(35)}`, null);
  put(`C${rowAt(35)}`, 'All amounts in CAD');
  for (const row of [cost, sell, profit]) { sheet.getCell(`E${row}`).numFmt = moneyFormat; sheet.getRow(row).height = 30; }
  for (const row of [cost, sell]) sheet.getCell(`L${row}`).numFmt = moneyFormat;
  for (const row of [39, 40, 41, 42]) {
    const value = String(sheet.getCell(`C${rowAt(row)}`).value || '');
    mergedText(`C${rowAt(row)}:M${rowAt(row)}`, value);
    sheet.getRow(rowAt(row)).height = 28;
  }
  // Additional app fields stay on the same worksheet, below the original layout.
  const taxRow = rowAt(44), totalRow = taxRow + 1;
  mergedText(`C${taxRow}:E${taxRow}`, 'Tax rate / tax CAD'); put(`F${taxRow}`, draft.taxPercent / 100); sheet.getCell(`F${taxRow}`).numFmt = '0.00%';
  formula(`L${taxRow}`, `ROUND(E${sell}*F${taxRow},2)`, calc.tax);
  mergedText(`C${totalRow}:G${totalRow}`, 'Total including tax (CAD)');
  formula(`L${totalRow}`, `ROUND(E${sell}+L${taxRow},2)`, calc.cadTotal);
  for (const row of [taxRow, totalRow]) { sheet.getCell(`L${row}`).numFmt = moneyFormat; sheet.getRow(row).height = 25; }
  mergedText(`C${taxRow + 3}:M${taxRow + 3}`, `Valid for ${draft.validityDays} days. Rate book: ${draft.bookId}, version ${draft.bookVersion}. Formula: ${FORMULA_VERSION}.`);
  sheet.getRow(taxRow + 3).height = 30;
  sheet.pageSetup.printArea = `A1:M${taxRow + 3}`;
  return book;
}
