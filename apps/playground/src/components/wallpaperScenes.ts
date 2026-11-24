/**
 * Procedural live wallpapers, one full-screen WebGL2 fragment shader per scene. Every scene
 * draws a light and a dark look and blends them by `uDark`, so a theme change can crossfade
 * instead of cutting.
 *
 * Glass refraction is only visible where the backdrop has structure, so each scene keeps
 * something crisp under the rim: fold ridges, metaball edges, contour rules, aurora hems
 * or bokeh rims. The soft mesh gradient is the exception and is kept as a calm reference.
 */
import type { ThemeMode } from '@sessile/core'

export const WALLPAPER_SCENES = ['folds', 'lava', 'contours', 'aurora', 'bokeh', 'mesh'] as const
export type WallpaperScene = (typeof WALLPAPER_SCENES)[number]

export const WALLPAPER_FOLD_COUNT = 8

/**
 * Fold colors from back to front: Prussian-blue folds lit by sodium-amber front folds, in the
 * bench palette. Neighbouring folds differ enough that their edges read when the glass bends them.
 */
export const WALLPAPER_PALETTES: Readonly<Record<ThemeMode, readonly string[]>> = {
  light: ['#e8eef7', '#cddcf0', '#a6c2ea', '#7aa3e0', '#4a7fd0', '#2753a8', '#f3c24f', '#e8892e'],
  dark: ['#0b2140', '#14306a', '#1f4fa8', '#2f74dc', '#5aa0f0', '#a8d3fa', '#f5bd3d', '#e07b2a'],
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

function glslVec3Array(hexes: readonly string[]): string {
  const items = hexes.map((hex) => {
    const [r, g, b] = hexToRgb(hex)
    return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`
  })
  return `vec3[${hexes.length}](${items.join(', ')})`
}

export const WALLPAPER_VERTEX_SHADER = `#version 300 es
void main() {
  // Single oversized triangle covering clip space; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// Shared prelude. The dither is static (no time term): a per-frame dither would make every
// pixel change each frame and force the backdrop filter to re-sample needlessly.
const PRELUDE = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDark;
out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = mat2(1.7, 1.1, -1.1, 1.7) * p + 3.1;
    a *= 0.5;
  }
  return v;
}

void emit(vec3 light, vec3 dark) {
  vec3 c = mix(light, dark, uDark);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

// Tilted folds, each filling below a slow sum-of-sines ridge with a sheen, a hairline crest, a
// cast shadow and faint pleats parallel to the ridge.
const FOLDS = `${PRELUDE}
const vec3 FL[${WALLPAPER_FOLD_COUNT}] = ${glslVec3Array(WALLPAPER_PALETTES.light)};
const vec3 FD[${WALLPAPER_FOLD_COUNT}] = ${glslVec3Array(WALLPAPER_PALETTES.dark)};

float ridge(float fk, float x, float t) {
  return 1.0 - fk * 0.125
    + 0.062 * sin(x * 1.55 + t * 0.23 + fk * 1.9)
    + 0.030 * sin(x * 3.30 - t * 0.31 + fk * 0.7)
    + 0.012 * sin(x * 7.10 + t * 0.47 + fk * 2.6);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = vec2((uv.x - 0.5) * uRes.x / uRes.y, uv.y - 0.5);
  float c = cos(-0.32), s = sin(-0.32);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + vec2(0.0, 0.5);

  vec3 light = FL[0] * (0.94 + 0.08 * uv.y);
  vec3 dark = FD[0] * (0.94 + 0.08 * uv.y);
  for (int k = 1; k < ${WALLPAPER_FOLD_COUNT}; k++) {
    float d = p.y - ridge(float(k), p.x, uTime);
    float aa = fwidth(d) * 0.75;
    float shadow = 1.0 - 0.3 * exp(-max(d, 0.0) / 0.05) * step(0.0, d);
    light *= shadow;
    dark *= shadow;
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float depth = clamp(-d / 0.32, 0.0, 1.0);
    float phase = -d * 190.0;
    float pleat = smoothstep(1.0 - fwidth(phase) * 0.35 - 0.06, 1.0, cos(phase));
    float shade = 1.0 - 0.14 * pleat * (1.0 - 0.6 * depth);
    float crest = 0.16 * exp(-abs(d) / 0.0045);
    vec3 fl = mix(FL[k] * 1.12 + 0.03, FL[k] * 0.8, depth) * shade + crest;
    vec3 fd = mix(FD[k] * 1.12 + 0.03, FD[k] * 0.8, depth) * shade + crest;
    light = mix(light, fl, inside);
    dark = mix(dark, fd, inside);
  }
  emit(light, dark);
}`

// Metaballs drifting on Lissajous paths. The iso-edge is anti-aliased but hard, with a bright
// sessile line just inside it: the closest thing in the set to liquid under glass.
const LAVA = `${PRELUDE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.18;
  float field = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.37 + 0.06 * fi) + fi * 2.4) * (0.5 * ar - 0.1),
                  sin(t * (0.29 + 0.05 * fi) + fi * 1.1 + 1.6) * 0.36);
    float r = 0.085 + 0.045 * fract(sin(fi * 12.9898) * 43758.5453);
    vec2 d = p - c;
    field += r * r / max(dot(d, d), 1e-5);
  }
  float aa = fwidth(field) * 1.1;
  float inside = smoothstep(1.0 - aa, 1.0 + aa, field);
  float core = clamp((field - 1.0) * 0.5, 0.0, 1.0);
  float rim = (1.0 - smoothstep(1.0, 1.08, field)) * inside;
  float halo = (1.0 - inside) * smoothstep(0.35, 1.0, field);

  vec3 bgL = mix(vec3(0.93, 0.95, 0.98), vec3(0.85, 0.90, 0.97), uv.y);
  vec3 blobL = mix(vec3(0.17, 0.35, 0.80), vec3(0.06, 0.16, 0.44), core) + rim * 0.32;
  vec3 light = mix(bgL - halo * 0.06, blobL, inside);

  vec3 bgD = mix(vec3(0.03, 0.07, 0.15), vec3(0.06, 0.12, 0.24), uv.y);
  vec3 blobD = mix(vec3(1.0, 0.68, 0.22), vec3(0.93, 0.34, 0.15), core) + rim * 0.25;
  vec3 dark = mix(bgD + halo * blobD * 0.3, blobD, inside);
  emit(light, dark);
}`

// Rings spreading from drifting drops, terraced like a contour map: each step is a soft colour
// shift with a fine rule on its edge, so the glass has crisp lines to bend without the rings
// turning into op-art.
const CONTOURS = `${PRELUDE}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.25;
  vec2 drops[3] = vec2[3](
    vec2(-0.45 + 0.10 * sin(t * 0.7), 0.18 + 0.08 * cos(t * 0.5)),
    vec2(0.40 + 0.08 * cos(t * 0.6), -0.20 + 0.10 * sin(t * 0.8)),
    vec2(0.05 * sin(t * 0.4), 0.42 + 0.05 * cos(t * 0.9)));
  float h = 0.55 * p.y + 0.25 * fbm(p * 1.6 + t * 0.2);
  for (int i = 0; i < 3; i++) {
    float d = length(p - drops[i]);
    h += 0.16 * cos(d * 22.0 - t * 2.4 - float(i) * 2.0) * exp(-d * 2.2);
  }
  float q = h * 7.0;
  float level = clamp((floor(q) + 4.0) / 9.0, 0.0, 1.0);
  float edge = abs(fract(q) - 0.5);
  // fract(q) wraps at each terrace edge, where the distance from the band centre reaches 0.5.
  float rule = smoothstep(0.5 - 1.5 * fwidth(q), 0.5, edge);

  vec3 light = mix(vec3(0.93, 0.95, 0.99), vec3(0.20, 0.42, 0.84), level);
  light = mix(light, vec3(0.08, 0.20, 0.46), rule * 0.55);
  vec3 dark = mix(vec3(0.03, 0.07, 0.15), vec3(0.16, 0.42, 0.80), level);
  dark = mix(dark, vec3(0.97, 0.76, 0.32), rule * 0.8);
  emit(light, dark);
}`

// Curtains with a sharp lower hem and fine vertical rays: dawn by day, a starry night by dark.
const AURORA = `${PRELUDE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.06;
  vec3 light = mix(vec3(0.99, 0.90, 0.82), vec3(0.66, 0.80, 0.97), uv.y);
  vec3 dark = mix(vec3(0.02, 0.06, 0.13), vec3(0.0, 0.01, 0.04), uv.y);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (0.9 + 0.3 * fi) + fi * 5.0;
    float center = 0.40 + 0.15 * fi + 0.25 * (fbm(vec2(x * 0.7, t + fi * 2.0)) - 0.5);
    float dy = uv.y - center;
    float curtain = dy < 0.0 ? exp(dy * 30.0) : exp(-dy * 4.5);
    float rays = 0.4 + 0.6 * fbm(vec2(x * 16.0, t * 1.5 + fi * 4.0));
    float g = curtain * rays;
    vec3 tint = fi < 0.5 ? vec3(0.32, 0.86, 0.66) : (fi < 1.5 ? vec3(0.36, 0.66, 1.0) : vec3(0.78, 0.52, 1.0));
    light = mix(light, tint * 0.9, min(1.0, g * 0.8));
    dark += tint * g * 0.8;
  }
  float star = step(0.9975, hash12(floor(gl_FragCoord.xy / 2.0)));
  dark += star * uv.y * (0.55 + 0.35 * sin(uTime * 1.7 + hash12(floor(gl_FragCoord.xy)) * 40.0));
  emit(light, dark);
}`

// Out-of-focus highlights drifting up in depth layers. Each disk has the brighter rim a real
// lens gives its bokeh, which doubles as a crisp edge for the glass to bend.
const BOKEH = `${PRELUDE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.05;
  vec3 light = mix(vec3(0.95, 0.96, 0.99), vec3(0.80, 0.87, 0.97), uv.y);
  vec3 dark = mix(vec3(0.04, 0.07, 0.15), vec3(0.01, 0.02, 0.06), uv.y);
  for (int l = 0; l < 4; l++) {
    float fl = float(l);
    float near = 1.0 - fl / 4.0;
    vec2 q = p * (3.0 + fl * 1.6) + vec2(t * 0.3 * (1.0 + fl * 0.4), -t * (0.8 + 0.4 * fl)) + fl * 11.0;
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash12(cell + fl * 31.0);
    // Offset plus radius stays inside the cell so no disk is clipped at a cell border.
    vec2 off = (vec2(hash12(cell + 5.0), hash12(cell + 9.0)) - 0.5) * 0.3;
    float r = 0.13 + 0.13 * hash12(cell + 2.0);
    float d = length(f - off);
    float aa = fwidth(d) * 1.5;
    float disk = step(h, 0.5) * smoothstep(r + aa, r - aa, d);
    float ring = disk * smoothstep(r - 0.035, r, d);
    vec3 tone = hash12(cell + 7.0) > 0.45 ? vec3(0.36, 0.62, 1.0) : vec3(1.0, 0.72, 0.26);
    light = mix(light, mix(tone, vec3(1.0), 0.4), disk * (0.25 + 0.2 * near) + ring * 0.25);
    dark += tone * (disk * 0.32 + ring * 0.4) * near;
  }
  emit(light, dark);
}`

// Soft color fields drifting into one another, warped by noise. Deliberately smooth: it shows
// how little a lens has to bend when the backdrop has no edges.
const MESH = `${PRELUDE}
const vec3 ML[5] = vec3[5](vec3(0.99, 0.80, 0.62), vec3(0.70, 0.78, 1.0), vec3(0.55, 0.75, 1.0), vec3(0.86, 0.72, 0.98), vec3(1.0, 0.88, 0.60));
const vec3 MD[5] = vec3[5](vec3(0.08, 0.12, 0.36), vec3(0.30, 0.10, 0.48), vec3(0.02, 0.32, 0.52), vec3(0.04, 0.05, 0.18), vec3(0.62, 0.36, 0.10));
void main() {
  float ar = uRes.x / uRes.y;
  vec2 p = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.1;
  vec2 q = p + 0.3 * vec2(fbm(p * 1.3 + t), fbm(p * 1.3 - t + 4.2)) - 0.15;
  vec3 light = vec3(0.0);
  vec3 dark = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(0.5 * ar, 0.5) + vec2(cos(t * (0.6 + 0.15 * fi) + fi * 1.9) * 0.45 * ar,
                                        sin(t * (0.8 + 0.12 * fi) + fi * 2.7) * 0.4);
    float w = 1.0 / (pow(length(q - c), 2.2) + 0.02);
    light += w * ML[i];
    dark += w * MD[i];
    total += w;
  }
  float sheen = 0.95 + 0.08 * fbm(p * 2.2 - t);
  emit(light / total * sheen, dark / total * sheen);
}`

export const WALLPAPER_FRAGMENT_SHADERS: Readonly<Record<WallpaperScene, string>> = {
  folds: FOLDS,
  lava: LAVA,
  contours: CONTOURS,
  aurora: AURORA,
  bokeh: BOKEH,
  mesh: MESH,
}

/** Hard-stop CSS approximation shown before the first frame and kept without WebGL2. */
export function wallpaperFallbackCss(theme: ThemeMode): string {
  const colors = WALLPAPER_PALETTES[theme]
  const step = 100 / colors.length
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ')
  return `linear-gradient(170deg, ${stops})`
}
