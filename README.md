# Meniscus

**Live-DOM Continuous Glass Morphing Engine for the Web.**

Meniscus enables real, interactive HTML elements to morph continuously as physical glass materials — merging via smooth-minimum (`smin`) signed distance fields, stretching liquid bridges, pinching off, and bouncing back with interruptible spring physics.

## Key Capabilities

- **Continuous N-Primitive Fusion**: Arbitrary numbers of rounded-rectangle / capsule / circular glass primitives smoothly merge and separate in real time without freezing the underlying DOM into static screenshots.
- **Zero-GC Stored-PNG Displacement Pipeline**: Analytical SDF + inward anti-aliasing alpha encoded into stored PNG (`BTYPE=00`) data URLs at 60/120fps for SVG `feDisplacementMap` refraction and RGB chromatic dispersion.
- **Route B3 Self-Masked Backdrop Refraction**: Unclipped SVG refraction sibling self-masked to shape alpha to prevent Chromium rectangular `backdrop-filter` bounding-box leaks.
- **Zero-Leak Marching Squares Contour**: High-precision contour extraction for live DOM `clip-path` and graceful fallback shapes.
- **WebGL2 + 2D Edge Optics**: Perimeter-only transparent overlay rendering outside shadows, outer hairlines, and directional superellipse specular highlights with `0px` seam alignment.
- **Progressive Enhancement**:
  - **Chromium**: Full live-DOM refractive distortion, chromatic dispersion, and edge optics.
  - **Safari / Firefox**: Liquid SDF contour, frosted backdrop, and physical edge specular highlights.

## Monorepo Layout

| Package | Description |
| --- | --- |
| `@meniscus/core` | Zero-dependency pure TypeScript kernel: N-primitive SDF field, optics parser/interpolator, spring physics, stored-PNG displacement map builder, Marching Squares contour extractor, and WebGL2/2D edge renderer. |
| `@meniscus/dom` | Framework-agnostic headless DOM surface controller managing the 3-layer hybrid architecture, capability detection, `ResizeObserver`, and `requestAnimationFrame` frame sync. |
| `@meniscus/react` | Thin React bindings (`<GlassField>`, `<GlassPrimitive>`, `useGlassMorph`, `useElasticPress`). |
| `@meniscus/presets` | Optional interaction presets (morphing popover/menu, segmented pill, drag-and-merge) decoupled from the core material engine. |
| `@meniscus/playground` | Interactive online lab showcasing multi-primitive fusion, optics tuning, degradation comparison, and production presets. |

## Status

Pre-release (`0.x`). APIs may change between minor versions. Published packages ship compiled ES modules and type declarations from `dist/`; inside this workspace they resolve to `src/` so tests and the playground run against the sources.

```sh
pnpm add @meniscus/core @meniscus/dom @meniscus/presets
pnpm add @meniscus/react   # React 19 bindings, optional
```

## Development

Requires Node.js 24+ and the pnpm version pinned in `package.json` (`packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm dev          # start the playground
pnpm typecheck    # TypeScript across the workspace
pnpm lint         # oxlint over packages and apps
pnpm test         # node --test across the workspace
pnpm build        # build every package and the playground
```

## License

[MPL-2.0](LICENSE). Each published package ships its own copy of the license text.
