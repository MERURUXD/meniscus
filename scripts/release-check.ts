/**
 * Packs every publishable `@sessile/*` package exactly as `pnpm publish` would and checks the
 * tarballs before anything reaches npm:
 *
 * - all packages share one version (and it matches `--tag vX.Y.Z` when given),
 * - internal dependencies are `workspace:*` in the repo and pinned to that exact version in
 *   the tarball,
 * - CHANGELOG.md has an entry for the version,
 * - each tarball holds only `package.json`, `LICENSE`, an optional README and `dist/`,
 *   every `exports` target exists, and no file contains a carriage return (a Windows checkout
 *   with `core.autocrlf` used to leak CRLF into LICENSE and the GLSL template strings).
 *
 * It then writes `release-manifest.json` (publish order + SHA-256 of each tarball) next to the
 * tarballs, so `release-publish.ts` uploads the exact bytes that were checked.
 *
 * Usage:
 *   pnpm release:check                       # pack into .release/ and check
 *   pnpm release:check --tag v0.3.3          # also require the tag, a clean tree, a CHANGELOG entry
 *   pnpm release:check --out /tmp/tarballs
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  MANIFEST_FILE,
  ROOT,
  SEMVER_RE,
  listPublishablePackages,
  parseFlag,
  readJson,
  sha256File,
  type ManifestEntry,
  type ReleaseManifest,
  type WorkspacePackage,
} from './release-lib.ts'

const ALLOWED_TOP_LEVEL = new Set(['package.json', 'LICENSE', 'README.md', 'dist'])
const REQUIRED_FILES = ['package.json', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full).split('\\').join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

/** Collects every string leaf of an `exports` value (conditions and subpaths alike). */
function exportTargets(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) exportTargets(nested, into)
  }
  return into
}

function tarballName(pkg: WorkspacePackage): string {
  return `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
}

function checkWorkspaceManifests(packages: WorkspacePackage[], expectedVersion: string | null): string {
  if (packages.length === 0) {
    fail('no publishable packages found under packages/')
    return ''
  }

  const versions = new Set(packages.map((pkg) => pkg.version))
  if (versions.size !== 1) {
    fail(`packages disagree on version: ${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`)
  }
  const version = packages[0]!.version
  if (!SEMVER_RE.test(version)) fail(`version "${version}" is not MAJOR.MINOR.PATCH[-pre]`)
  if (expectedVersion !== null && version !== expectedVersion) {
    fail(`tag asks for ${expectedVersion} but packages are at ${version}`)
  }

  for (const pkg of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = (pkg.manifest[field] ?? {}) as Record<string, string>
      for (const [dep, range] of Object.entries(deps)) {
        if (!dep.startsWith('@sessile/')) continue
        if (field === 'dependencies' && range !== 'workspace:*') {
          fail(`${pkg.name}: ${field}.${dep} should be "workspace:*" in the repo, found "${range}"`)
        }
        if (field !== 'dependencies') {
          fail(`${pkg.name}: internal package ${dep} belongs in dependencies, not ${field}`)
        }
      }
    }
  }

  return version
}

function checkChangelog(version: string): void {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm')
  if (!heading.test(changelog)) fail(`CHANGELOG.md has no "## [${version}]" entry`)
}

function checkTarball(pkg: WorkspacePackage, version: string, tarball: string, scratch: string): void {
  const extractDir = mkdtempSync(join(scratch, `${pkg.dir}-`))
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir])
  const root = join(extractDir, 'package')
  if (!existsSync(root)) {
    fail(`${pkg.name}: tarball has no package/ root`)
    return
  }

  const files = listFiles(root)
  for (const file of files) {
    const top = file.split('/')[0]!
    if (!ALLOWED_TOP_LEVEL.has(top)) fail(`${pkg.name}: unexpected file in tarball: ${file}`)
    if (readFileSync(join(root, file)).includes(0x0d)) {
      fail(`${pkg.name}: ${file} contains CR (CRLF line endings); repack from an LF checkout`)
    }
  }
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) fail(`${pkg.name}: tarball is missing ${required}`)
  }

  const packed = readJson(join(root, 'package.json'))
  if (packed.name !== pkg.name) fail(`${pkg.name}: packed name is ${String(packed.name)}`)
  if (packed.version !== version) fail(`${pkg.name}: packed version is ${String(packed.version)}`)

  for (const field of DEPENDENCY_FIELDS) {
    const deps = (packed[field] ?? {}) as Record<string, string>
    for (const [dep, range] of Object.entries(deps)) {
      if (range.startsWith('workspace:')) fail(`${pkg.name}: packed ${field}.${dep} still says "${range}"`)
      if (dep.startsWith('@sessile/') && range !== version) {
        fail(`${pkg.name}: packed ${field}.${dep} is "${range}", expected exactly "${version}"`)
      }
    }
  }

  const targets = exportTargets(packed.exports)
  if (targets.length === 0) fail(`${pkg.name}: packed package.json has no exports`)
  for (const target of targets) {
    const normalized = target.replace(/^\.\//, '')
    if (!files.includes(normalized)) fail(`${pkg.name}: exports target ${target} is not in the tarball`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const tag = parseFlag(argv, '--tag')
  const outDir = resolve(ROOT, parseFlag(argv, '--out') ?? '.release')

  let expectedVersion: string | null = null
  if (tag !== null) {
    if (!/^v/.test(tag)) fail(`tag "${tag}" should look like v1.2.3`)
    expectedVersion = tag.replace(/^v/, '')
    const dirty = git(['status', '--porcelain', '--untracked-files=no'])
    if (dirty !== '') fail(`working tree has uncommitted changes, so tarballs would not match ${tag}:\n${dirty}`)
  }

  const packages = listPublishablePackages()
  const version = checkWorkspaceManifests(packages, expectedVersion)
  if (version !== '') checkChangelog(version)
  if (errors.length > 0) return report()

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'sessile-release-'))
  const entries: ManifestEntry[] = []

  try {
    for (const pkg of packages) {
      // `prepack` wipes dist/ and rebuilds it, so the tarball never carries a stale build.
      execFileSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: pkg.path, stdio: ['ignore', 'ignore', 'inherit'] })
      const file = tarballName(pkg)
      const tarball = join(outDir, file)
      if (!existsSync(tarball)) {
        fail(`${pkg.name}: pnpm pack did not produce ${file}`)
        continue
      }
      checkTarball(pkg, version, tarball, scratch)
      entries.push({ name: pkg.name, version, file, sha256: sha256File(tarball) })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  let commit: string | null = null
  try {
    commit = git(['rev-parse', 'HEAD'])
  } catch {
    commit = null
  }

  const manifest: ReleaseManifest = { version, commit, packages: entries }
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)

  if (errors.length === 0) {
    console.log(`release-check: ${entries.length} packages at ${version} packed into ${relative(ROOT, outDir) || '.'}`)
    for (const entry of entries) console.log(`  ${entry.name}@${entry.version}  ${entry.sha256}`)
  }
  report()
}

function report(): void {
  if (errors.length === 0) return
  console.error(`release-check failed (${errors.length}):`)
  for (const message of errors) console.error(`  - ${message}`)
  process.exitCode = 1
}

main()
