/**
 * Sets the same version on every publishable `@sessile/*` package, so a release never ships
 * packages that disagree. It only edits `packages/<name>/package.json`; the CHANGELOG entry, the
 * commit and the tag stay manual (see RELEASING.md).
 *
 * Usage:
 *   pnpm release:version 0.3.3
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEMVER_RE, listPublishablePackages } from './release-lib.ts'

function main(): void {
  const version = process.argv[2]?.replace(/^v/, '')
  if (!version || !SEMVER_RE.test(version)) {
    console.error('usage: pnpm release:version <MAJOR.MINOR.PATCH[-pre]>')
    process.exitCode = 1
    return
  }

  for (const pkg of listPublishablePackages()) {
    const path = join(pkg.path, 'package.json')
    const source = readFileSync(path, 'utf8')
    // Replace only the top-level "version" field to keep the file's formatting untouched.
    const next = source.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`)
    if (next === source && pkg.version !== version) throw new Error(`${path}: no "version" field found`)
    writeFileSync(path, next)
    console.log(`${pkg.name}: ${pkg.version} -> ${version}`)
  }
}

main()
