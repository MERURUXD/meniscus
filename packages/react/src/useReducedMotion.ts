/**
 * Reactive React hook subscribing to `(prefers-reduced-motion: reduce)` via `@meniscus/dom`.
 * Uses `useSyncExternalStore` so SSR, hydration, and live OS toggles stay tear-free
 * without external animation libraries.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { useCallback, useSyncExternalStore } from 'react'
import {
  observeReducedMotion,
  prefersReducedMotion,
  type CapabilityEnv,
} from '@meniscus/dom'

const getServerSnapshot = (): boolean => false

/**
 * Returns whether reduced motion is currently preferred and stays synchronized
 * with live OS/browser media query changes. Safely returns `false` during SSR.
 */
export function useReducedMotion(env?: CapabilityEnv): boolean {
  const hasCustomMatchMedia = env !== undefined && 'matchMedia' in env
  const customMatchMedia = env?.matchMedia

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const activeEnv: CapabilityEnv | undefined = hasCustomMatchMedia
        ? { matchMedia: customMatchMedia }
        : undefined
      return observeReducedMotion(() => {
        onStoreChange()
      }, activeEnv)
    },
    [hasCustomMatchMedia, customMatchMedia],
  )

  const getSnapshot = useCallback(() => {
    const activeEnv: CapabilityEnv | undefined = hasCustomMatchMedia
      ? { matchMedia: customMatchMedia }
      : undefined
    return prefersReducedMotion(activeEnv)
  }, [hasCustomMatchMedia, customMatchMedia])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
