import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry0 from '../src/index.ts'
import * as entry1 from '../src/entries/legibility.ts'
import * as entry2 from '../src/entries/internal.ts'

/**
 * Snapshot of every runtime export per entry point. A change here is a public API change:
 * update the list on purpose and record it in CHANGELOG.md.
 */
const ENTRIES: ReadonlyArray<readonly [string, object, readonly string[]]> = [
  ['@sessile/dom', entry0, [
    'GlassSurfaceController',
    'buildBackdropFilterCss',
    'buildMaterialFromCssSurface',
    'cancelAnimationFrameSafe',
    'computeClampedRefractBounds',
    'createFrameLoop',
    'createGlassSurfaceController',
    'createRefractFilterController',
    'detectSurfaceCapabilities',
    'formatRgbaCss',
    'measureElementBorderBox',
    'observeElementResize',
    'observeReducedMotion',
    'prefersReducedMotion',
    'readElementGlassSurface',
    'resolveEffectiveRenderMode',
    'resolveElementTheme',
    'scheduleAnimationFrame',
    'supportsSvgBackdropRefraction',
  ]],
  ['@sessile/dom/legibility', entry1, [
    'createRegionProbe',
    'measureImageTelemetry',
  ]],
  ['@sessile/dom/internal', entry2, [
    'DEFAULT_MAX_REFRACT_MAP_PIXELS',
    'SVG_NS',
    'computeAutoBezel',
    'computeAutoSurfaceBounds',
    'formatOpaqueSolidCss',
    'parseCssBackdropBlur',
    'parseCssBackdropSaturate',
    'resetCapabilityCache',
    'resolveEffectiveMapScale',
    'resolveFieldBezel',
  ]],
]

for (const [spec, mod, expected] of ENTRIES) {
  test(`${spec} exposes exactly the documented runtime exports`, () => {
    assert.deepEqual(Object.keys(mod).sort(), [...expected].sort())
  })
}
