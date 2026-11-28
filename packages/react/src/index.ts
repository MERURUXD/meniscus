/**
 * Public entry point for `@sessile/react`.
 * Lightweight React 19 hooks for Sessile glass surfaces.
 *
 * The declarative field components (`<GlassField>`, `<GlassPrimitive>`, `useGlassMorph`)
 * ship as `@sessile/react/experimental` until a production host adopts them.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export { useReducedMotion } from './useReducedMotion.ts'
export {
  useElasticPress,
  type UseElasticPressOptions,
} from './useElasticPress.ts'
