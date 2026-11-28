/**
 * Shared helpers for the release scripts (`release-check.ts`, `release-publish.ts`,
 * `release-version.ts`). Node built-ins only, so they run before `pnpm install` finishes
 * resolving anything and stay out of the published packages.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..')

export interface WorkspacePackage {
  /** Directory name under `packages/`. */
  dir: string
  /** Absolute path of the package directory. */
  path: string
  name: string
  version: string
  /** `@sessile/*` packages this one depends on at runtime. */
  internalDeps: string[]
  manifest: Record<string, unknown>
}

/** Strict `MAJOR.MINOR.PATCH` with an optional `-prerelease` (no build metadata). */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Every non-private package under `packages/`, in dependency order (dependencies first). */
export function listPublishablePackages(): WorkspacePackage[] {
  const packagesDir = join(ROOT, 'packages')
  const found: WorkspacePackage[] = []

  for (const dir of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (manifest.private === true) continue
    const deps = (manifest.dependencies ?? {}) as Record<string, string>
    found.push({
      dir,
      path: join(packagesDir, dir),
      name: String(manifest.name),
      version: String(manifest.version),
      internalDeps: Object.keys(deps).filter((dep) => dep.startsWith('@sessile/')),
      manifest,
    })
  }

  return topoSort(found)
}

function topoSort(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const ordered: WorkspacePackage[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (pkg: WorkspacePackage): void => {
    const mark = state.get(pkg.name)
    if (mark === 'done') return
    if (mark === 'visiting') throw new Error(`dependency cycle through ${pkg.name}`)
    state.set(pkg.name, 'visiting')
    for (const dep of pkg.internalDeps) {
      const target = byName.get(dep)
      if (target) visit(target)
    }
    state.set(pkg.name, 'done')
    ordered.push(pkg)
  }

  for (const pkg of packages) visit(pkg)
  return ordered
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** One tarball recorded by `release-check.ts` and consumed by `release-publish.ts`. */
export interface ManifestEntry {
  name: string
  version: string
  file: string
  sha256: string
}

export interface ReleaseManifest {
  version: string
  /** Commit the tarballs were packed from, when known. */
  commit: string | null
  /** Tarballs in publish order (dependencies first). */
  packages: ManifestEntry[]
}

export const MANIFEST_FILE = 'release-manifest.json'

export function parseFlag(argv: readonly string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === flag && i + 1 < argv.length) return argv[i + 1]!
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return null
}
