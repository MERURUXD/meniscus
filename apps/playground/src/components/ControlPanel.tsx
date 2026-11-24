import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react'

export interface SliderControlProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  precision?: number
  defaultValue?: number
  onChange: (value: number) => void
}

export function SliderControl({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  precision = 0,
  defaultValue,
  onChange,
}: SliderControlProps): ReactElement {
  const span = max - min
  const pct = span > 0 ? Math.max(0, Math.min(100, ((value - min) / span) * 100)) : 0
  const rangeStyle = { '--slider-pct': `${pct.toFixed(2)}%` } as CSSProperties

  return (
    <div className="pg-slider-row">
      <label
        className="pg-slider-header"
        htmlFor={id}
        onDoubleClick={
          defaultValue !== undefined ? () => onChange(defaultValue) : undefined
        }
      >
        <span className="pg-slider-label">{label}</span>
        <span className="pg-slider-value">
          {value.toFixed(precision)}
          {unit}
        </span>
      </label>
      <input
        id={id}
        type="range"
        className="pg-range"
        style={rangeStyle}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export interface ControlSectionProps {
  title: string
  children: ReactNode
}

export function ControlSection({ title, children }: ControlSectionProps): ReactElement {
  return (
    <section className="pg-section">
      <h3 className="pg-section-title">{title}</h3>
      <div className="pg-section-body">{children}</div>
    </section>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

export interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  columns?: number
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  size = 'md',
  columns,
}: SegmentedControlProps<T>): ReactElement {
  const style = columns
    ? ({ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } as CSSProperties)
    : undefined

  return (
    <div
      className="pg-seg"
      role="radiogroup"
      aria-label={ariaLabel}
      data-size={size}
      data-grid={columns ? 'true' : 'false'}
      style={style}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className="pg-seg-item"
            onClick={() => onChange(opt.value)}
          >
            {opt.icon ? (
              <span className="pg-seg-icon" aria-hidden="true">
                {opt.icon}
              </span>
            ) : null}
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export interface SwitchControlProps {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

export function SwitchControl({
  id,
  label,
  checked,
  disabled = false,
  onChange,
}: SwitchControlProps): ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="pg-switch-row"
      onClick={() => onChange(!checked)}
    >
      <span className="pg-switch-label">{label}</span>
      <span className="pg-switch-track" aria-hidden="true">
        <span className="pg-switch-thumb" />
      </span>
    </button>
  )
}

export interface TelemetryGridProps {
  children: ReactNode
}

export function TelemetryGrid({ children }: TelemetryGridProps): ReactElement {
  return <dl className="pg-telemetry">{children}</dl>
}

export interface TelemetryItemProps {
  label: string
  value: ReactNode
  valueRef?: Ref<HTMLElement>
}

export function TelemetryItem({
  label,
  value,
  valueRef,
}: TelemetryItemProps): ReactElement {
  return (
    <div className="pg-stat">
      <dt className="pg-stat-label">{label}</dt>
      <dd className="pg-stat-value">
        <span ref={valueRef}>{value}</span>
      </dd>
    </div>
  )
}

export interface ControlPanelProps {
  title: string
  description: string
  headerSlot?: ReactNode
  children: ReactNode
}

export function ControlPanel({
  title,
  description,
  headerSlot,
  children,
}: ControlPanelProps): ReactElement {
  return (
    <aside className="pg-panel">
      {headerSlot ? <div className="pg-panel-switcher">{headerSlot}</div> : null}
      <div className="pg-panel-head">
        <h2 className="pg-panel-title">{title}</h2>
        <p className="pg-panel-note">{description}</p>
      </div>
      {children}
    </aside>
  )
}
