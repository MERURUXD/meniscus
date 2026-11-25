# Changelog

All notable changes to the published `@sessile/*` packages (`@sessile/core`, `@sessile/dom`, `@sessile/presets`, `@sessile/react`) are documented in this file.

## [Unreleased]

### Added

- **Adaptive Backdrop Legibility (`@sessile/core`, `@sessile/dom`)**: The host fixes the foreground (text color, optional polarity, tier `clear` / `regular` / `legible` or an explicit WCAG contrast) and the glass yields. `@sessile/core` adds the goal solver (`resolveLegibilityGoal`), risk mapping (`computeBackdropRisk`), the allocation-free material response (`resolveLegibilityParams`, `createLegibilityParams`), an area-weighted telemetry accumulator and grid measurement (`createTelemetryAccumulator`, `measureTelemetryGrid`; telemetry carries luminance and channel-extreme tails so host `brightness` / `contrast` are bounded on colored backdrops, with the dark tail in `srgbLuma`), an attack/hold/release smoother (`createAsymmetricSmoother`), and `tryParseCssRgba` (returns `null` for colors it cannot resolve). `@sessile/dom` adds `GlassSurfaceControllerOptions.legibility`, `setLegibility`, `setBackdropTelemetry` and `getLegibilityParams`, the `BackdropProbe` plugin contract, `createRegionProbe` and the CORS-respecting `measureImageTelemetry`. On Chromium a luminance / table / arithmetic stage (composed on an alpha-flattened copy, then re-masked) between `refractSmooth` and the self-mask compresses the backdrop per pixel, always meeting the ceiling while risk moves only the knee. Safari and Firefox get a film plus a separate `brightness` / `contrast` correction stage after the host's veil optics (`LegibilityParams.fallbackVeil`, `BuildBackdropFilterCssParams.correction`). Edge Optics compensation scales alphas only. Updates never re-encode the Stored-PNG map or resize layers.

### Fixed

- **Nine-Slice Joint Seams (`@sessile/dom`)**: Circles and capsules no longer show a cross or mid-line seam on the Route B3 refraction map. Corner tiles and edge strips used to abut where `span` or `rise` collapsed to `0`, and once the filter was rasterized at a non-integer device offset (fractional DPR, subpixel `transform`), the antialiased joint dropped map alpha and leaked unrefracted backdrop. All 9 pieces are now always emitted with a `2 * pad` overlap underlay, so subpixel-positioned capsules also stay on the nine-slice path instead of falling back to the full map.

## [0.2.0] - 2026-11-24

### Breaking Changes

- **Snell's Law Geometric Optics Refraction (`@sessile/core`, `@sessile/dom`)**: Replaced the legacy empirical power-law refraction curves (`power`, `falloff` on `RefractMapParams` and `RefractFilterConfig`) with a physical 1D Snell's Law bezel lookup table (`profile`, `ior`, `thicknessRatio` / `strength`, `caustics`) and `NORMAL_FLOOR = 0.25` saddle softening to eliminate 180° gradient flips across `smin` necks.
- **Calibrated SVG Displacement Scale (`@sessile/dom`)**: Calibrated `feDisplacementMap` scale to `2 * maxDisplacementPx * scaleMultiplier` derived directly from the resolved Snell profile and suppressed chromatic dispersion to `0` when base displacement is zero.

### Added

- **Snell Profile LUT & Optional 3D Rim Optics (`@sessile/core`)**: Added `computeRefractionProfileLut`, `resolveRefractionProfileLut`, `sampleRefractionLut`, `traceBezelRay`, `BEZEL_HEIGHT_PROFILES` (`'squircle'`, `'circle'`, `'parabolic'`, `'lip'`), `CAUSTIC_FOLD_LIMIT`, and `NORMAL_FLOOR`. Added optional `'physical'` 3D slope lighting to `RimMode` while keeping `'directional'` and `'soft'` as the defaults.
- **Nine-Slice Fast Path (`@sessile/core`, `@sessile/dom`, #13)**: Added a shared 64-entry LRU tile generator (`resolveRefractTiles`, `clearRefractTilesCache`, `MAX_REFRACT_TILE_PX`) and an adaptive Route B3 self-masked `<feFlood>` + `<feImage>` + `<feMerge result="map">` SVG filter stage (`RefractFilterConfig.nineSlice`, default `true`). Single-primitive surfaces keep 1:1 edges, support `cornerBend` (`radius < bezel`), and resize with zero PNG re-encoding or `href` writes, falling back automatically for `N=0`, `N >= 2` liquid bridges, tiny elements, and subpixel-positioned capsules.
- **Full-Map Pixel Budget & CLI Benchmark Suite (`@sessile/dom`, `pnpm bench`, #14)**: Added `DEFAULT_MAX_REFRACT_MAP_PIXELS = 96_000`, `resolveEffectiveMapScale`, and `RefractFilterConfig.maxMapPixels` (`0` disables capping) to bound full-field Stored-PNG encoding area to final rounded PNG dimensions without degrading compact `<= 128px` 1:1 controls. Added a zero-dependency Node CLI benchmark suite (`pnpm bench`, supporting `--quick`, `--json`, and `--filter`).
- **Area-Preserving 2D Motion Model (`@sessile/core`, `@sessile/presets`, #15)**: Added `computeAreaPreservingScale`, `deformSizePreservingArea`, and `AreaPreservingScale` (`scaleX = s^cos(2*theta)`, `scaleY = 1 / scaleX`). Integrated directional rubber-band stretch (`ElasticPressOptions.dragStretchRatio`, default `0.12`), area-conserving `SegmentedPillOptions.preserveArea` (default `true`), and bounds-clamped velocity squash-and-stretch with aligned mid-flight `hitTest()` in `DragMergeOptions` (`velocityStretch`, default `0.08`, and `velocityStretchReferencePxPerSec`, default `900`).
- **Capability Detection Hardening (`@sessile/dom`)**: Hardened `supportsSvgBackdropRefraction` against iPadOS desktop-mode (`Macintosh` + `maxTouchPoints > 1`) user agents and Chromium `userAgentDataBrands`.

### Migration Guide (`0.1.0` -> `0.2.0`)

1. **Update refraction configuration keys**:

   | `0.1.0` option | `0.2.0` replacement | Notes |
   | --- | --- | --- |
   | `power` | `profile` | `'squircle'` (default), `'circle'`, `'parabolic'`, `'lip'`, or custom `BezelHeightFn` |
   | `falloff` | `ior` + `caustics` | Index of refraction `ior` defaults to `1.5`; `caustics` defaults to `false` |
   | `strength` / displacement gain | `strength` (`RefractFilterConfig`) / `thicknessRatio` (`RefractMapParams`) | Dimensionless glass plateau thickness divided by bezel width |

2. **Optional opt-out flags for new default behaviors**:
   - Disable 9-slice SVG map composition: `nineSlice: false`
   - Disable full-map encoded pixel area capping: `maxMapPixels: 0`
   - Disable directional press/drag squash-and-stretch: `dragStretchRatio: 0` (`useElasticPress` / `createElasticPressController`)
   - Keep legacy linear squeeze ratios on segmented pills: `preserveArea: false`
   - Disable spring velocity stretch on drag-merge nodes: `velocityStretch: 0`

## [0.1.0]

Initial public release of `@sessile/core`, `@sessile/dom`, `@sessile/presets`, and `@sessile/react` under the `@sessile/*` package scope.
