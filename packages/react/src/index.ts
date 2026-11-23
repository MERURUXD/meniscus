/**
 * Public entry point for `@meniscus/react`.
 * Lightweight React 19 components and hooks for Meniscus glass morphing surfaces.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export { GlassField, type GlassFieldProps } from './GlassField.ts'
export { GlassPrimitive, type GlassPrimitiveProps } from './GlassPrimitive.ts'
export {
  useGlassField,
  useOptionalGlassField,
  type GlassFieldContextValue,
  type RegisteredGlassPrimitive,
} from './GlassFieldContext.ts'
export { useReducedMotion } from './useReducedMotion.ts'
export {
  useGlassMorph,
  type UseGlassMorphOptions,
  type UseGlassMorphResult,
} from './useGlassMorph.ts'
export {
  useElasticPress,
  type UseElasticPressOptions,
} from './useElasticPress.ts'
