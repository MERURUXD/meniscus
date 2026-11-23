/**
 * Internal React context and ref utilities connecting `<GlassPrimitive>` children
 * to their enclosing `<GlassField>` surface controller.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  type Ref,
} from 'react'
import type { GlassSurfaceController } from '@meniscus/dom'

export interface RegisteredGlassPrimitive {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  radius?: number
  weight?: number
  active?: boolean
  getElement?: () => HTMLElement | null
}

export interface GlassFieldContextValue {
  registerPrimitive(entry: RegisteredGlassPrimitive): void
  updatePrimitive(entry: RegisteredGlassPrimitive): void
  unregisterPrimitive(id: string): void
  requestRender(): void
  getContainer(): HTMLDivElement | null
  getController(): GlassSurfaceController | null
  getResizeObserverCtor?: () => typeof ResizeObserver | undefined
}

export const GlassFieldContext = createContext<GlassFieldContextValue | null>(null)

/** SSR-safe layout effect hook falling back to `useEffect` outside browser environments. */
export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Assigns a value to either a callback ref or a mutable React ref object. */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): (() => void) | void {
  if (!ref) return undefined
  if (typeof ref === 'function') {
    const cleanup = ref(value)
    return typeof cleanup === 'function' ? cleanup : undefined
  }
  ;(ref as { current: T | null }).current = value
  return undefined
}

/** Returns the nearest parent `<GlassField>` context, throwing if mounted outside one. */
export function useGlassField(): GlassFieldContextValue {
  const ctx = useContext(GlassFieldContext)
  if (!ctx) {
    throw new Error('useGlassField must be used within a <GlassField> component.')
  }
  return ctx
}

/** Returns the nearest parent `<GlassField>` context, or `null` if none exists. */
export function useOptionalGlassField(): GlassFieldContextValue | null {
  return useContext(GlassFieldContext)
}
