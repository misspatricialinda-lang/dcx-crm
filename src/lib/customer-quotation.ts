export type QuotationItem = { id?: string; product_service: string; description: string; quantity: number | string; unit_price: number | string; line_total?: number; position?: number };
export type CustomerQuotation = { id: string; customer_id: string; estimate_number: number; recipient_snapshot: { name: string; contact?: string; email?: string; phone?: string; billing_address?: string }; address_1: string; status: 'draft' | 'issued'; version: number; tax_rate: number; subtotal: number; tax_total: number; grand_total: number; issued_at?: string | null; created_at: string; items: QuotationItem[] };
export const cents = (value: number | string) => { const n = Number(value || 0); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
export const lineCents = (row: QuotationItem) => { const quantity = Number(row.quantity || 0); return Number.isFinite(quantity) ? Math.round(quantity * cents(row.unit_price)) : 0; };
export function totals(items: QuotationItem[], taxRate = 13) {
  const subtotalCents = items.reduce((sum, row) => sum + lineCents(row), 0);
  const taxCents = Math.round(subtotalCents * taxRate / 100);
  return { subtotal: subtotalCents / 100, tax: taxCents / 100, total: (subtotalCents + taxCents) / 100 };
}
export const cad = (value: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value);

const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
let logoPromise: Promise<string> | null = null;
export function quotationLogo() {
  if (!logoPromise) logoPromise = fetch('/dcx-quotation-logo.png').then(response => { if (!response.ok) throw new Error('DCX logo could not be loaded.'); return response.blob(); }).then(dataUrl).catch(error => { logoPromise = null; throw error; });
  return logoPromise;
}
export async function buildCustomerQuotationPdf(q: CustomerQuotation, logo: string) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const blue: [number, number, number] = [75, 154, 198];
  let firstTableY = 246;
  const text = (value: string, x: number, y: number, size = 10, bold = false) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(0); doc.text(value, x, y); };
  const bar = (x: number, y: number, w: number, h: number) => { doc.setFillColor(...blue); doc.rect(x, y, w, h, 'F'); };
  const header = (first: boolean) => {
    doc.addImage(logo, 'PNG', 32, 35, 200, 77);
    text('DCX Technical Inc.', 240, 63, 17, true);
    text('33 Cardiff Road  |  Toronto, Ontario M4P 2N8', 240, 78, 9);
    text('1-844-329-6999  |  services@dcx-tech.com  |  www.dcx-tech.com', 240, 90, 9);
    if (first) {
      text('RECIPIENT:', 32, 158, 9, true);
      const recipient = q.recipient_snapshot;
      text(recipient.name || '', 32, 181, 12, true);
      const addressLines = doc.splitTextToSize(recipient.billing_address || '', 275) as string[];
      addressLines.forEach((line, i) => text(line, 32, 197 + 13 * i, 10));
      bar(340, 138, 240, 32);
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(q.estimate_number > 0 ? `Estimate #${q.estimate_number}` : 'Estimate #Pending', 350, 160);
      const address1Lines = doc.splitTextToSize(q.address_1, 138) as string[];
      const extra = Math.max(0, address1Lines.length - 1) * 11;
      doc.setFillColor(238, 238, 238); doc.rect(340, 170, 240, 42 + extra, 'F');
      text('Sent on', 350, 184, 10); doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(0); doc.text(new Date(q.issued_at || q.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }), 570, 184, { align: 'right' });
      text('Address 1:', 350, 202, 10); address1Lines.forEach((line,i) => doc.text(line, 570, 202 + 11*i, { align: 'right' }));
      bar(340, 212 + extra, 240, 23);
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Total', 350, 229 + extra); doc.text(cad(Number(q.grand_total)), 570, 229 + extra, { align: 'right' });
      firstTableY = Math.max(246 + extra, 197 + addressLines.length * 13 + 12);
    }
  };
  const tableHead = (y: number) => {
    bar(32, y, 548, 22);
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('Product/Service', 38, y + 15); doc.text('Description', 165, y + 15);
    doc.text('Qty.', 435, y + 15, { align: 'right' }); doc.text('Unit Price', 510, y + 15, { align: 'right' }); doc.text('Total', 575, y + 15, { align: 'right' });
  };
  header(true); let y = firstTableY;
  if (y > 645) { doc.addPage(); header(false); y = 140; }
  tableHead(y); y += 22;
  for (const row of q.items) {
    const nameLines = doc.splitTextToSize(row.product_service || 'New item', 115) as string[];
    const descLines = doc.splitTextToSize(row.description || '', 255) as string[];
    let nameAt = 0, descAt = 0, firstSegment = true;
    do {
      if (y + 30 > 676) { doc.addPage(); header(false); y = 140; tableHead(y); y += 22; }
      const capacity = Math.max(1, Math.floor((676 - y - 14) / 12));
      const namePart = nameLines.slice(nameAt, nameAt + capacity);
      const descPart = descLines.slice(descAt, descAt + capacity);
      const height = Math.max(30, Math.max(namePart.length, descPart.length) * 12 + 14);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(0);
      if (namePart.length) doc.text(namePart, 38, y + 14);
      else if (!firstSegment) doc.text('(continued)', 38, y + 14);
      if (descPart.length) doc.text(descPart, 165, y + 14);
      if (firstSegment) {
        doc.text(String(row.quantity), 435, y + 14, { align: 'right' });
        doc.text(cad(Number(row.unit_price || 0)), 510, y + 14, { align: 'right' });
        doc.text(cad(Number(row.line_total ?? lineCents(row) / 100)), 575, y + 14, { align: 'right' });
      }
      doc.setDrawColor(185); doc.line(32, y + height, 580, y + height); y += height;
      nameAt += namePart.length; descAt += descPart.length; firstSegment = false;
    } while (nameAt < nameLines.length || descAt < descLines.length);
  }
  if (y + 112 > 738) { doc.addPage(); header(false); y = 140; }
  y += 12; doc.setDrawColor(140); doc.line(32, y, 580, y); y += 18;
  const totalRow = (label: string, amount: number, bold = false) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(10); doc.setTextColor(0); doc.text(label, 480, y, { align: 'right' }); doc.rect(490, y - 12, 90, 20); doc.text(cad(amount), 575, y, { align: 'right' }); y += 20; };
  totalRow('Subtotal', Number(q.subtotal)); totalRow(`HST ON (${q.tax_rate}%)`, Number(q.tax_total)); totalRow('Total', Number(q.grand_total), true);
  y += 12; text('This quote is valid for the next 30 days, after which values may be subject to change.', 32, y, 9);
  text('Unless otherwise stated, Freight is NOT included.', 32, y + 20, 9);
  if (q.status === 'draft') { doc.setTextColor(160, 40, 40); doc.setFontSize(9); doc.text('DRAFT - NOT ISSUED', 580, 765, { align: 'right' }); }
  return doc;
}
export async function exportCustomerQuotation(q: CustomerQuotation) {
  const logo = await quotationLogo();
  const doc = await buildCustomerQuotationPdf(q, logo);
  doc.save(`DCX-Estimate-${q.estimate_number}.pdf`);
}
