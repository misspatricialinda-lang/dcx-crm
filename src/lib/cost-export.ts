import type { QuoteDraft } from '../types/operations';
import { buildCostWorkbook } from './cost-workbook.ts';
export { buildCostWorkbook } from './cost-workbook.ts';

export function downloadBlob(blob:Blob,name:string) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export const exportName=(title:string)=> (title.replace(/[^a-z0-9_-]+/gi,'-').slice(0,70)||'cost-table');
export async function exportCostXlsx(draft:QuoteDraft) {
  const book=await buildCostWorkbook(draft),buffer=await book.xlsx.writeBuffer();
  downloadBlob(new Blob([new Uint8Array(buffer)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),`${exportName(draft.bookId)}-${exportName(draft.title)}.xlsx`);
}
