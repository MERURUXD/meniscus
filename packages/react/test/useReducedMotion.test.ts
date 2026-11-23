/**
 * Unit tests for `useReducedMotion` covering SSR safety, initial reads,
 * live `change` updates, and unmount listener cleanup.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { CapabilityEnv } from '@meniscus/dom'
import { useReducedMotion } from '../src/useReducedMotion.ts'
import { createMockMediaQueryList, installDomEnv } from './testEnv.ts'

function Probe({ env, onValue }: { env?: CapabilityEnv; onValue: (v: boolean) => void }) {
  const reduced = useReducedMotion(env)
  onValue(reduced)
  return createElement('span', { 'data-reduced': String(reduced) })
}

test('useReducedMotion safely returns false during SSR when matchMedia is absent', () => {
  const values: boolean[] = []
  const html = renderToStaticMarkup(
    createElement(Probe, { onValue: (v) => values.push(v) }),
  )
  assert.equal(html, '<span data-reduced="false"></span>')
  assert.deepEqual(values, [false])
})

test('useReducedMotion reads initial preference, tracks live changes, and cleans up on unmount', async () => {
  const env = installDomEnv()
  try {
    const mql = createMockMediaQueryList(true)
    const capEnv: CapabilityEnv = {
      matchMedia: () => mql,
    }
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    const seen: boolean[] = []

    await act(async () => {
      root.render(createElement(Probe, { env: capEnv, onValue: (v) => seen.push(v) }))
    })

    assert.equal(seen[seen.length - 1], true)
    assert.equal(mql.getListenerCount(), 1)

    await act(async () => {
      mql.setMatches(false)
    })
    assert.equal(seen[seen.length - 1], false)

    await act(async () => {
      mql.setMatches(true)
    })
    assert.equal(seen[seen.length - 1], true)

    await act(async () => {
      root.unmount()
    })
    assert.equal(mql.getListenerCount(), 0)

    const countBefore = seen.length
    mql.setMatches(false)
    assert.equal(seen.length, countBefore)
  } finally {
    await env.restore()
  }
})
