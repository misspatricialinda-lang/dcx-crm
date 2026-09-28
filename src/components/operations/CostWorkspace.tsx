export { WorkbookCalculator as CostWorkspace } from './WorkbookCalculator';
export { CustomerQuotes as QuotesPage } from './CustomerQuotes';
export function NumberField({ label, value, onChange, step = '0.01', min = 0, max }: { label: string; value: number; onChange: (value: number) => void; step?: string; min?: number; max?: number }) {
  return <label>{label}<input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={event => onChange(event.target.value === '' ? 0 : Number(event.target.value))} /></label>;
}
