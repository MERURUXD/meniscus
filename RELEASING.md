# Releasing

All four packages (`@sessile/core`, `@sessile/dom`, `@sessile/presets`, `@sessile/react`) share one version and are published together by the [`release`](.github/workflows/release.yml) workflow. Nothing is published from a local machine.

## Cutting a release

1. On a branch, bump every package at once:

   ```sh
   pnpm release:version 0.3.3
   ```

2. Add a `## [0.3.3] - YYYY-MM-DD` entry to [CHANGELOG.md](CHANGELOG.md).
3. Check locally (optional, CI runs it on every PR):

   ```sh
   pnpm release:check
   ```

4. Open the `chore(release): prepare v0.3.3` PR and merge it into `main`.
5. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.3.3 -m "v0.3.3"
   git push origin v0.3.3
   ```

The tag starts the workflow:

- **pack**: refuses tags that are not on `main`, runs typecheck, lint and tests, then `pnpm release:check --tag v0.3.3` packs each package with `pnpm pack` and checks the tarballs (versions agree with the tag, internal dependencies pinned to the same version, CHANGELOG entry present, only `package.json` / `LICENSE` / `dist/` inside, every `exports` target present, no CRLF). The tarballs and a SHA-256 manifest are uploaded as an artifact.
- **publish**: downloads that artifact, verifies the checksums and runs `npm publish <tarball> --provenance` for each package in dependency order (`core`, then `dom` and `presets`, then `react`). Versions already on npm are skipped, so re-running a failed job only publishes what is missing. A pre-release version such as `0.4.0-rc.0` goes to the `next` dist-tag.

## One-time setup: npm trusted publishing

The workflow authenticates to npm with OIDC, so no npm token is stored in GitHub. For each of the four packages, on npmjs.com open **Settings → Trusted publishing** and add a GitHub Actions publisher:

| Field | Value |
| --- | --- |
| Organization or user | `MERURUXD` |
| Repository | `sessile` |
| Workflow filename | `release.yml` |
| Environment | leave empty |

Provenance is attached automatically, and the npm page of each version links back to the commit and workflow run that built it.

If you would rather use a token, create a granular npm access token with publish rights to `@sessile/*`, add it as the `NPM_TOKEN` repository secret, and add `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the "Publish checked tarballs" step.

## Line endings

`.gitattributes` keeps every text file LF, including on Windows checkouts with `core.autocrlf=true`. Earlier releases (0.1.0 to 0.3.2) were packed from such a checkout: their `LICENSE` files and the GLSL template strings in `@sessile/core`'s `dist/overlayRenderer.js` carry CRLF that the repository does not. `release:check` fails if a tarball contains a carriage return.
