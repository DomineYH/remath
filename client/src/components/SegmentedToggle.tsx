export interface SegOption<V extends string> { value: V; label: string }
interface Props<V extends string> { options: SegOption<V>[]; value: V; onChange: (v: V) => void; ariaLabel: string; label?: string; className?: string }

export function SegmentedToggle<V extends string>({ options, value, onChange, ariaLabel, label, className }: Props<V>) {
  return (
    <div className={['seg', className].filter(Boolean).join(' ')} role="group" aria-label={ariaLabel}>
      {label && <span>{label}</span>}
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
