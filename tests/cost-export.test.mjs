import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildCostWorkbook } from '../src/lib/cost-export.ts';
import { calculateCost } from '../src/lib/costing.ts';

const line = {id:'1',rateItemId:'1',description:'=SUM(A1:A2)',supplier:'Test',unit:'hour',supplierCost:100,multiplier:1,manualCost:100,costMode:'manual',quantity:1.5,exchangeRate:1,margin:.25};
const draft = {customerId:'',title:'Test worksheet',site:'Test site',bookId:'standard',bookVersion:1,currency:'CAD',validityDays:30,notes:'Keep all notes',lines:[line,{...line,id:'2',description:'Unused row retained',quantity:0}],flatLines:[{id:'f',description:'Flat',amount:50,addition:10}],shipping:5,brokerage:2,usdRate:.75,taxPercent:13};
async function reopen(input) {
  const book = await buildCostWorkbook(input), reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await book.xlsx.writeBuffer());
  assert.deepEqual(reopened.worksheets.map(s=>s.name), ['Job Cost Sheet']);
  return reopened.getWorksheet('Job Cost Sheet');
}
test('export matches the client template and preserves formulas, literal text and totals', async () => {
  const sheet = await reopen(draft);
  assert.equal(sheet.getCell('C1').value,'JOB COST WORKSHEET');
  assert.equal(sheet.getCell('C11').value,'=SUM(A1:A2)\n(hour)');
  assert.equal(sheet.getCell('F11').value,100);
  assert.equal(sheet.getCell('D12').value,100);
  assert.equal(sheet.getCell('F12').value,100);
  assert.equal(sheet.getCell('G12').value,0);
  assert.equal(sheet.getCell('K12').value,.25);
  assert.equal(sheet.getCell('M11').result,200);
  assert.equal(sheet.getCell('M11').formula,'J11/(1-K11)');
  assert.equal(sheet.getCell('K11').value,.25);
  assert.equal(sheet.getCell('M22').result,60);
  assert.equal(sheet.getCell('H22').result,60);
  assert.equal(sheet.getCell('M22').formula,'H22');
  assert.equal(sheet.getCell('E29').result,157);
  assert.equal(sheet.getCell('E31').result,260);
  assert.equal(sheet.getCell('E33').result,103);
  assert.equal(sheet.getCell('L45').result,293.8);
  assert.equal(sheet.getCell('B26').value,'Keep all notes');
  assert.equal(sheet.getCell('D11').fill.fgColor.argb,'FFFFFF00');
  assert.equal(sheet.getCell('B11').fill.fgColor.argb,'FFCCFFFF');
  assert.equal(sheet.getCell('L4').value instanceof Date,true);
  assert.equal(sheet.getCell('F13').value,null);
  assert.equal(sheet.pageSetup.printArea,'A1:M47');
  assert.equal(sheet.getCell('L5').value,'CAD');
  assert.equal(sheet.getCell('C35').value,'All amounts in CAD');
  assert.doesNotMatch(JSON.stringify(sheet.getSheetValues()), /USD|Exchange Rate/);
});
test('additional lines and flat items expand the template with all totals referencing shifted cells', async () => {
  const input={...draft,currency:'USD',lines:Array.from({length:15},(_,i)=>({...line,id:String(i),costMode:i===14?'multiplier':'manual',multiplier:.375,quantity:i+.125,exchangeRate:.74})),flatLines:Array.from({length:5},(_,i)=>({id:String(i),description:`Flat ${i}`,amount:20+i,addition:3}))};
  const sheet=await reopen(input),calc=calculateCost(input);
  assert.equal(sheet.getCell('A25').value,15);
  assert.equal(sheet.getCell('F25').formula,'D25*E25');
  assert.equal(sheet.getCell('F25').result,37.5);
  assert.equal(sheet.getCell('M31').result,27);
  assert.equal(sheet.getCell('E37').result,calc.totalCost);
  assert.equal(sheet.getCell('E39').formula,'SUM(M11:M25)+SUM(M27:M31)');
  assert.equal(sheet.getCell('E39').result,calc.sellingPrice);
  assert.equal(sheet.getCell('L53').result,calc.cadTotal);
  assert.equal(sheet.getCell('L53').formula,'ROUND(E39+L52,2)');
  assert.equal(sheet.getCell('C53').value,'Total including tax (CAD)');
  assert.equal(sheet.getCell('B34').value,draft.notes);
});
test('empty sheets have no sample values; invalid inputs cannot export', async () => {
  const sheet=await reopen({...draft,lines:[],flatLines:[],shipping:0,brokerage:0});
  assert.equal(sheet.getCell('L33').result,'N/A');
  assert.equal(sheet.getCell('E31').result,0);
  assert.equal(sheet.getCell('F11').value,null);
  await assert.rejects(buildCostWorkbook({...draft,lines:[{...line,margin:1}]}),/invalid/);
  const legacy = await reopen({...draft,currency:'USD',usdRate:0});
  assert.equal(legacy.getCell('L45').result,293.8);
});
