# Sessile

**Live-DOM Continuous Glass Morphing Engine for the Web.**

Sessile enables real, interactive HTML elements to morph continuously as physical glass materials — merging via smooth-minimum (`smin`) signed distance fields, stretching liquid bridges, pinching off, and bouncing back with interruptible spring physics.

## Key Capabilities

- **Continuous N-Primitive Fusion**: Arbitrary numbers of rounded-rectangle / capsule / circular glass primitives smoothly merge and separate in real time without freezing the underlying DOM into static screenshots.
- **Snell's Law Geometric Optics 1D LUT**: Physically traced bezel refraction (`squircle`, `circle`, `parabolic`, `lip`, or custom cross-sections) with configurable `ior`, anti-caustic fold clamping, and `NORMAL_FLOOR` saddle softening across `smin` necks.
- **Nine-Slice Fast Path & Bounded Full-Map Stored-PNG**: Single-primitive shapes share 64-entry LRU-cached 1:1 edge and corner tiles for zero-reencode resizing, seamlessly falling back to pixel-budgeted (`maxMapPixels`) zero-GC Stored-PNG (`BTYPE=00`) maps during `N >= 2` liquid fusion.
- **Route B3 Self-Masked Backdrop Refraction**: Unclipped SVG refraction sibling self-masked to shape alpha to prevent Chromium rectangular `backdrop-filter` bounding-box leaks.
- **Zero-Leak Marching Squares Contour & Area-Preserving Springs**: High-precision contour extraction paired with interruptible analytical springs and 2D incompressible squash-and-stretch motion.
- **WebGL2 + 2D Edge Optics**: Perimeter-only transparent overlay rendering outside shadows, outer hairlines, and directional or optional physical 3D rim specular highlights with `0px` seam alignment.
- **Adaptive Backdrop Legibility**: The host fixes the foreground (text color and a `clear` / `regular` / `legible` tier, i.e. WCAG 3 / 4.5 / 7); the glass yields. On Chromium a luminance-keyed multiplicative film inside the Route B3 filter compresses the backdrop per pixel while keeping hue, so one pane over bright, dark and saturated cover art still meets the target. Elsewhere a film plus a separate `backdrop-filter` brightness/contrast stage runs after the host's own optics, solved on telemetry that carries channel extremes so host `saturate` / `brightness` / `contrast` stay bounded on colored backdrops. Risk from host-injected telemetry or a `BackdropProbe` drives film, blur, displacement attenuation and edge alphas through an attack/hold/release smoother. None of these updates re-encodes the displacement map.

  ```ts
  const probe = createRegionProbe({ background: pageTelemetry })
  probe.set(coverEl, measureImageTelemetry(coverCanvas)!)
  controller.setLegibility({ foreground: [1, 1, 1], tier: 'regular', probe })
  ```
- **Resting Surfaces on the Same Pipeline**: `backdropTarget: 'container'` lets a plain element (a button, a toolbar, a dialog) render through the controller with the backdrop filter and tint on the element itself, so its own fade and scale animations keep sampling the page; pair it with `createGlassOverlayRenderer({ webgl: false })` when a page holds dozens of them.
- **Progressive Enhancement**:
  - **Chromium**: Full live-DOM refractive distortion, chromatic dispersion, and edge optics.
  - **Safari / Firefox**: Liquid SDF contour, frosted backdrop, and physical edge specular highlights.

## Monorepo Layout

| Package | Description |
| --- | --- |
| `@sessile/core` | Zero-dependency pure TypeScript kernel: N-primitive SDF field, Snell 1D LUT & 9-slice tile cache, optics parser/interpolator, area-preserving spring physics, stored-PNG displacement map builder, Marching Squares contour extractor, WebGL2/2D edge renderer, and the adaptive legibility solver with backdrop telemetry. |
| `@sessile/dom` | Framework-agnostic headless DOM surface controller managing the 3-layer hybrid architecture, switchable 9-slice / bounded full-map Route B3 SVG filter, per-pixel legibility filter stage and backdrop probes, capability detection, `ResizeObserver`, and `requestAnimationFrame` frame sync. |
| `@sessile/react` | Thin React bindings (`<GlassField>`, `<GlassPrimitive>`, `useGlassMorph`, `useElasticPress`). |
| `@sessile/presets` | Optional interaction presets (morphing popover/menu, area-preserving segmented pill, velocity-stretched drag-and-merge) decoupled from the core material engine. |
| `@sessile/playground` | Interactive online lab showcasing multi-primitive fusion, optics tuning, degradation comparison, a colorful cover-wall legibility stress test, and production presets. |

## Status

Pre-release (`0.x`, see [CHANGELOG.md](CHANGELOG.md)). APIs may change between minor versions. Published packages ship compiled ES modules and type declarations from `dist/`; inside this workspace they resolve to `src/` so tests and the playground run against the sources.

```sh
pnpm add @sessile/core @sessile/dom @sessile/presets
pnpm add @sessile/react   # React 19 bindings, optional
```

## Development

Requires Node.js 24+ and the pnpm version pinned in `package.json` (`packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm dev          # start the playground
pnpm typecheck    # TypeScript across the workspace
pnpm lint         # oxlint over packages, apps, and scripts
pnpm test         # node --test across the workspace
pnpm bench        # CLI performance benchmarks (--quick, --json, --filter)
pnpm build        # build every package and the playground
```

## License

[MPL-2.0](LICENSE). Each published package ships its own copy of the license text.
