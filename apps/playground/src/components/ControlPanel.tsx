import type { ReactElement, ReactNode } from 'react'

export interface SliderControlProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  precision?: number
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
  onChange,
}: SliderControlProps): ReactElement {
  return (
    <label className="pg-slider-row" htmlFor={id}>
      <span className="pg-slider-header">
        <span>{label}</span>
        <span className="pg-slider-value">
          {value.toFixed(precision)}
          {unit}
        </span>
      </span>
      <input
        id={id}
        type="range"
        className="pg-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export interface ControlPanelProps {
  title: string
  description: string
  children: ReactNode
}

export function ControlPanel({ title, description, children }: ControlPanelProps): ReactElement {
  return (
    <aside className="pg-panel">
      <div>
        <h3 className="pg-panel-title">{title}</h3>
        <p className="pg-panel-note">{description}</p>
      </div>
      {children}
    </aside>
  )
}
