/**
 * Publishes the tarballs that `release-check.ts` packed and checked, in dependency order, so a
 * dependent package never lands on npm before the version it pins. Meant to run in the
 * `release` GitHub Actions workflow, where npm trusted publishing (OIDC) authenticates the
 * upload and attaches provenance.
 *
 * - Each tarball's SHA-256 must match `release-manifest.json`; the bytes that were checked are
 *   the bytes that are uploaded.
 * - A version already on the registry is skipped, so re-running a half-finished release only
 *   publishes what is missing.
 * - Pre-release versions (`1.2.3-rc.0`) go to the `next` dist-tag instead of `latest`.
 *
 * Usage:
 *   node scripts/release-publish.ts --dir .release            # publish
 *   node scripts/release-publish.ts --dir .release --dry-run  # npm publish --dry-run
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { MANIFEST_FILE, ROOT, parseFlag, readJson, sha256File, type ReleaseManifest } from './release-lib.ts'

function isPublished(name: string, version: string): boolean {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' })
  if (result.status !== 0) {
    // npm exits non-zero with E404 when the version does not exist yet.
    if (/E404|404 Not Found/.test(`${result.stdout}${result.stderr}`)) return false
    throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`)
  }
  return result.stdout.trim() !== ''
}

function main(): void {
  const argv = process.argv.slice(2)
  const dir = resolve(ROOT, parseFlag(argv, '--dir') ?? '.release')
  const dryRun = argv.includes('--dry-run')
  const manifest = readJson(join(dir, MANIFEST_FILE)) as unknown as ReleaseManifest

  if (manifest.packages.length === 0) throw new Error('release manifest lists no packages')
  for (const entry of manifest.packages) {
    const actual = sha256File(join(dir, entry.file))
    if (actual !== entry.sha256) {
      throw new Error(`${entry.file}: SHA-256 ${actual} does not match the checked tarball ${entry.sha256}`)
    }
  }

  const distTag = manifest.version.includes('-') ? 'next' : 'latest'
  console.log(`Publishing ${manifest.packages.length} packages at ${manifest.version} (dist-tag ${distTag})`)

  for (const entry of manifest.packages) {
    if (!dryRun && isPublished(entry.name, entry.version)) {
      console.log(`  skip ${entry.name}@${entry.version}: already on npm`)
      continue
    }
    const args = ['publish', join(dir, entry.file), '--access', 'public', '--tag', distTag]
    if (dryRun) args.push('--dry-run')
    else args.push('--provenance')
    console.log(`  npm ${args.join(' ')}`)
    execFileSync('npm', args, { stdio: 'inherit' })
  }
}

main()
