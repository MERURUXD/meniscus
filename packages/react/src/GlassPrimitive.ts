/**
 * Declarative `<GlassPrimitive>` component registering either explicit geometry
 * (headless mode) or a DOM-measured wrapper box (wrapper mode) into its parent `<GlassField>`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  createElement,
  useId,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { observeElementResize } from '@meniscus/dom'
import {
  assignRef,
  useGlassField,
  useIsomorphicLayoutEffect,
} from './GlassFieldContext.ts'

export interface GlassPrimitiveProps {
  /** Stable identifier within the `<GlassField>` (auto-generated via `useId()` when omitted). */
  id?: string
  /** Left coordinate relative to the `<GlassField>` padding box in CSS px. */
  x?: number
  /** Top coordinate relative to the `<GlassField>` padding box in CSS px. */
  y?: number
  /** Box width in CSS px (measured automatically in wrapper mode when omitted). */
  width?: number
  /** Box height in CSS px (measured automatically in wrapper mode when omitted). */
  height?: number
  /** Corner radius in CSS px (resolved from computed `borderTopLeftRadius` in wrapper mode when omitted). */
  radius?: number
  /** Optional SDF primitive weight. */
  weight?: number
  /** Whether this primitive participates in the active SDF field (default: `true`). */
  active?: boolean
  /** Child content; passing children, `className`, `style`, or `elementRef` enables wrapper mode. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
  elementRef?: Ref<HTMLDivElement | null>
}

/**
 * Registers a rounded-rectangle or capsule primitive into the enclosing `<GlassField>`.
 * Renders `null` when used headlessly with explicit geometry, or wraps children in a measured `<div>`.
 */
export function GlassPrimitive(props: GlassPrimitiveProps): ReactElement | null {
  const {
    id: explicitId,
    x,
    y,
    width,
    height,
    radius,
    weight,
    active = true,
    children,
    className,
    style,
    elementRef: elementRefProp,
  } = props

  const generatedId = useId()
  const primitiveId = explicitId ?? generatedId
  const field = useGlassField()

  const isWrapperMode =
    children !== undefined ||
    className !== undefined ||
    style !== undefined ||
    elementRefProp !== undefined

  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null)

  useIsomorphicLayoutEffect(() => {
    if (!isWrapperMode || !wrapperEl) return
    const cleanup = assignRef(elementRefProp, wrapperEl)
    return () => {
      if (cleanup) {
        cleanup()
      } else {
        assignRef(elementRefProp, null)
      }
    }
  }, [elementRefProp, isWrapperMode, wrapperEl])

  useIsomorphicLayoutEffect(() => {
    const entry = {
      id: primitiveId,
      x,
      y,
      width,
      height,
      radius,
      weight,
      active,
      getElement: isWrapperMode ? () => wrapperEl : undefined,
    }
    field.registerPrimitive(entry)
    field.requestRender()

    return () => {
      field.unregisterPrimitive(primitiveId)
    }
  }, [field, primitiveId, isWrapperMode])

  useIsomorphicLayoutEffect(() => {
    field.updatePrimitive({
      id: primitiveId,
      x,
      y,
      width,
      height,
      radius,
      weight,
      active,
      getElement: isWrapperMode ? () => wrapperEl : undefined,
    })
    field.requestRender()
  }, [
    field,
    primitiveId,
    x,
    y,
    width,
    height,
    radius,
    weight,
    active,
    isWrapperMode,
    wrapperEl,
    className,
    style,
  ])

  const resizeObserverCtor = field.getResizeObserverCtor?.()

  useIsomorphicLayoutEffect(() => {
    if (!isWrapperMode || !wrapperEl) return

    return observeElementResize(
      wrapperEl,
      () => {
        field.requestRender()
      },
      {
        ResizeObserverCtor: resizeObserverCtor,
        emitInitial: false,
      },
    )
  }, [field, isWrapperMode, wrapperEl, resizeObserverCtor])

  if (!isWrapperMode) {
    return null
  }

  return createElement('div', { ref: setWrapperEl, className, style }, children)
}
