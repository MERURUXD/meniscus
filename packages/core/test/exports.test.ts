import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry0 from '../src/index.ts'
import * as entry1 from '../src/entries/overlay.ts'
import * as entry2 from '../src/entries/legibility.ts'
import * as entry3 from '../src/entries/internal.ts'

/**
 * Snapshot of every runtime export per entry point. A change here is a public API change:
 * update the list on purpose and record it in CHANGELOG.md.
 */
const ENTRIES: ReadonlyArray<readonly [string, object, readonly string[]]> = [
  ['@sessile/core', entry0, [
    'DEFAULT_OPTICAL_MATERIALS',
    'DEFAULT_SPRINGS',
    'MAX_GPU_PRIMITIVES',
    'clamp',
    'computeAreaPreservingScale',
    'computeFieldBounds',
    'computePairMergeStatus',
    'computeRoundedBoxDistance',
    'computeRoundedBoxSdf',
    'computeSmin',
    'computeSminDistance',
    'createElasticPressController',
    'createMorphTimeline',
    'createPreparedField',
    'createSpringChannel',
    'cubicBezier',
    'deformSizePreservingArea',
    'easeInOutCubic',
    'easeInQuad',
    'easeOutCubic',
    'evaluateFieldDistance',
    'evaluateFieldSdf',
    'evaluateSpring',
    'evaluateSpringState',
    'extractFieldContourPath',
    'formatRoundedRectPath',
    'interpolateCssGlassSurfaceToMaterial',
    'interpolateOpticalMaterial',
    'interpolateVeilOptics',
    'lerp',
    'parseCssBoxShadow',
    'parseCssFilterOptics',
    'parseCssGlassSurface',
    'parseCssRgba',
    'prepareField',
    'resolveOpticalMaterial',
    'riseAndFall',
    'smoothstep',
    'tryParseCssRgba',
  ]],
  ['@sessile/core/overlay', entry1, [
    'createGlassOverlayRenderer',
  ]],
  ['@sessile/core/legibility', entry2, [
    'LEGIBILITY_CALM_KNEE',
    'LEGIBILITY_LIMIT_MARGIN',
    'LEGIBILITY_POLICIES',
    'LEGIBILITY_SMOOTHING',
    'LEGIBILITY_STAGES',
    'LEGIBILITY_TABLE_SIZE',
    'TELEMETRY_STRIDE',
    'compensateLegibilityEdges',
    'computeBackdropRisk',
    'contrastRatio',
    'createAsymmetricSmoother',
    'createLegibilityParams',
    'createTelemetryAccumulator',
    'linearToSrgb',
    'measureTelemetryGrid',
    'relativeLuminance',
    'resolveLegibilityGoal',
    'resolveLegibilityParams',
    'srgbLuma',
    'srgbToLinear',
  ]],
  ['@sessile/core/internal', entry3, [
    'BEZEL_HEIGHT_PROFILES',
    'CAUSTIC_FOLD_LIMIT',
    'DEFAULT_REFRACTION_IOR',
    'DEFAULT_REFRACTION_SAMPLES',
    'MAX_REFRACT_TILE_PX',
    'NORMAL_FLOOR',
    'OVERLAY_FRAGMENT_SHADER',
    'OVERLAY_VERTEX_SHADER',
    'buildCircularBevelTable',
    'buildColorOpticsMatrix',
    'buildContourAlphaDataUrl',
    'buildRefractMapDataUrl',
    'clearRefractTilesCache',
    'computeRefractionProfileLut',
    'createRefractMapBuilder',
    'getRefractionProfileKey',
    'resolveRefractTiles',
    'resolveRefractionProfileLut',
    'sampleRefractionLut',
    'traceBezelRay',
  ]],
]

for (const [spec, mod, expected] of ENTRIES) {
  test(`${spec} exposes exactly the documented runtime exports`, () => {
    assert.deepEqual(Object.keys(mod).sort(), [...expected].sort())
  })
}
