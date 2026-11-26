# Changelog

All notable changes to the published `@sessile/*` packages (`@sessile/core`, `@sessile/dom`, `@sessile/presets`, `@sessile/react`) are documented in this file.

## [Unreleased]

### Performance

- **Shared Legibility Cadence (`@sessile/dom`)**: Smoothed risk moves past the deadband now commit on the first frame of a shared 100ms slot (`RISK_COMMIT_INTERVAL_MS`), derived from the animation-frame timestamp, so every surface on the page rewrites its filter, veil and edge in the same frame. Surfaces that crossed the deadband in different frames used to keep Chromium repainting a backdrop filter on almost every frame of a scroll; on a library page with ~11 refracting surfaces this cut tint-on scroll GPU time by about a third. Settling and the first real sample still commit at once.
- **Shared Region Boxes (`@sessile/dom`)**: `createRegionProbe` reads each region's bounding box once per task and drops the boxes on every notification, so G surfaces sampling R regions in one scroll event read R rects instead of G x R.

## [0.3.1] - 2026-11-26

### Added

- **Container Backdrop (`@sessile/dom`)**: `GlassSurfaceControllerOptions.backdropTarget: 'container'` paints the backdrop sample and veil tint (legibility film and correction included) on the container itself and creates only the overlay canvas. It is meant for a single resting surface clipped by its own border radius: the host's opacity, filter or mask animations keep sampling the page, where a child backdrop layer would treat the animating host as its Backdrop Root. Refraction bounds default to the container's border box, and `clear` / `dispose` restore the container's own inline styles.
- **Shared Overlay Context (`@sessile/core`)**: `createGlassOverlayRenderer({ context: 'shared' })` draws every shared overlay with one page-wide WebGL2 context on an `OffscreenCanvas`. The surface only grows, each frame is drawn at its bottom-left corner and copied into the host's 2D canvas inside the same `render()` call, so hosts of different sizes never reallocate the drawing buffer. Pages with dozens of surfaces stay under the browser's live WebGL context cap (Chromium evicts the oldest past about 16) while resting and morphing surfaces keep the same shader. The context is created on first mount and released with the last host; without `OffscreenCanvas` or WebGL2, and while the context is lost, hosts draw with 2D Canvas. `context: '2d'` skips WebGL2 entirely.
- **Shared Edge Compensation (`@sessile/core`)**: `compensateLegibilityEdges(material, params, out)` applies the legibility response to a material's edge alphas (hairline and rim by `hairlineScale`, shadow by `shadowScale`) into a caller buffer. Hosts that draw their own morph overlay use it so the hand-off to a resting surface keeps the same edge.

### Performance

- **Legibility Before Displacement (`@sessile/dom`)**: The Route B3 legibility stage now compresses `bgOptics` before the displacement inputs instead of re-reading `refractSmooth`. Chromium evaluates a filter result once per reference, so the old stage ran the whole displacement chain three times per frame.
- **Risk Deadband (`@sessile/dom`)**: The smoothed risk re-resolves the response only after it moves by `0.02` or settles, so a backdrop scrolling under the glass no longer rewrites the filter and redraws the edge every frame. Settling always commits the exact target.

### Fixed

- **Subpixel-Stable Edge Lines (`@sessile/core`)**: The WebGL2 overlay's outer hairline, uniform inner border and glass edge now use box-filtered pixel coverage. Lines thinner than a pixel used to keep a smoothstep around their centre, so their total alpha swung by up to 1.7x as the shape moved by a fraction of a pixel: thin edges shimmered while morphing and jumped where a morph handed off to a resting surface at a different subpixel offset.
- **Popover Opening Lands on Open (`@sessile/presets`)**: The opening springs were still ringing at `openDurationSec`, so the last opening frame sat about 1.3px of corner radius (on a 360px panel) and a fraction of morph, dip and blur short of the resting `open` state, and the hand-off to a resting surface stepped. Their residuals now fade out from `POPOVER_MORPH_DEFAULTS.openLandingStart` (normalized `0.7`), so `evaluatePopoverMotion('opening', 1)` equals the `open` state and the geometry matches exactly.

## [0.3.0] - 2026-11-25

### Added

- **Adaptive Backdrop Legibility (`@sessile/core`, `@sessile/dom`)**: The host fixes the foreground (text color, optional polarity, tier `clear` / `regular` / `legible` or an explicit WCAG contrast) and the glass yields. `@sessile/core` adds the goal solver (`resolveLegibilityGoal`), risk mapping (`computeBackdropRisk`), the allocation-free material response (`resolveLegibilityParams`, `createLegibilityParams`), an area-weighted telemetry accumulator and grid measurement (`createTelemetryAccumulator`, `measureTelemetryGrid`; telemetry carries luminance and channel-extreme tails so host `brightness` / `contrast` are bounded on colored backdrops, with the dark tail in `srgbLuma`), an attack/hold/release smoother (`createAsymmetricSmoother`), and `tryParseCssRgba` (returns `null` for colors it cannot resolve). `@sessile/dom` adds `GlassSurfaceControllerOptions.legibility`, `setLegibility`, `setBackdropTelemetry` and `getLegibilityParams`, the `BackdropProbe` plugin contract, `createRegionProbe` and the CORS-respecting `measureImageTelemetry`. On Chromium a luminance / table / arithmetic stage (composed on an alpha-flattened copy, then re-masked) between `refractSmooth` and the self-mask compresses the backdrop per pixel, always meeting the ceiling while risk moves only the knee. Safari and Firefox get a film plus a separate `brightness` / `contrast` correction stage after the host's veil optics (`LegibilityParams.fallbackVeil`, `BuildBackdropFilterCssParams.correction`). Edge Optics compensation scales alphas only. Updates never re-encode the Stored-PNG map or resize layers.
- **Color & Contrast Helpers (`@sessile/core`)**: Exported `srgbToLinear`, `linearToSrgb`, `relativeLuminance`, `srgbLuma` and `contrastRatio`, plus the `LEGIBILITY_*` policy, smoothing and stage constants and `TELEMETRY_STRIDE` (6 floats per grid cell: `lumaHigh, lumaLow, channelHigh, channelLow, chroma, detail`).
- **Backdrop Filter Correction Stage (`@sessile/dom`)**: `buildBackdropFilterCss` accepts an optional `correction` brightness/contrast pair, emitted after `veil` as its own filter functions because CSS clamps between them.

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
