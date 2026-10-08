# Releasing Glimpse

A release is a git tag `vX.Y.Z`. Pushing it runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which publishes the `glimpse-ui` npm package and attaches the desktop installers to a GitHub Release.

## 1. Bump the versions

All three must say the same version (the workflow checks the first two against the tag):

| File | How |
|---|---|
| `packages/cli/package.json` | `"version": "X.Y.Z"` |
| `apps/desktop/package.json` (+ lockfile) | `cd apps/desktop && npm version X.Y.Z --no-git-tag-version` |
| `packages/cli/src/index.ts` | the string `glimpse --version` prints (the build fails if it doesn't match package.json) |

The root `package.json` and the `@glimpse/*` workspace packages are private and don't need to change.
Use a pre-release version such as `0.3.0-beta.1` to publish under npm's `next` tag and mark the GitHub Release as a
pre-release.

## 2. Check it locally

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
pnpm smoke:pack                     # npm pack → install the tarball in a temp dir → glimpse --version / open / mcp

cd apps/desktop
npm ci && npm run typecheck && npm test
npm run dist -- --dir               # unpacked app in release/
xvfb-run -a npm run smoke -- --packaged   # Linux; drop xvfb-run -a on macOS/Windows
```

## 3. Tag and push

```bash
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## What the workflow does

1. **check**: fails unless `packages/cli` and `apps/desktop` are at the tag's version.
2. **npm**: builds, tests, runs `pnpm smoke:pack`, then `npm publish --provenance --access public` from
   `packages/cli`. Skipped with a notice when the `NPM_TOKEN` secret isn't set or the version is already on npm;
   provenance is left off for private repositories (npm requires a public source repo for it).
3. **desktop** (macOS, Windows, Linux): `pnpm build`, `npm ci` in `apps/desktop`, then `npm run dist`:
   `.dmg` + `.zip` (arm64, x64), NSIS `.exe` (x64, arm64), `.AppImage` + `.deb` (x64). Signed when the optional
   secrets below are set, unsigned otherwise (with a notice).
4. **github-release**: creates the release for the tag with generated notes and every installer attached. Set the
   repository variable `RELEASE_DRAFT` to `true` to get a draft you publish by hand.

A failed job can be re-run from the Actions tab; publishing to npm is skipped if that version is already there.

## Secrets

Repository **Settings › Secrets and variables › Actions**:

| Secret | Needed for |
|---|---|
| `NPM_TOKEN` | Publishing to npm: an npm *granular access token* with read/write access to `glimpse-ui` (or a classic *Automation* token). The first publish creates the package. |

### Optional signing secrets

| Secret | Platform | What |
|---|---|---|
| `MAC_CSC_LINK` | macOS | Developer ID Application certificate, `.p12`, base64 |
| `MAC_CSC_KEY_PASSWORD` | macOS | Its password |
| `APPLE_API_KEY_P8` | macOS | App Store Connect API key, contents of the `.p8` file (enables notarization) |
| `APPLE_API_KEY_ID` | macOS | The key's ID |
| `APPLE_API_ISSUER` | macOS | The issuer ID |
| `WIN_CSC_LINK` | Windows | Authenticode certificate, `.pfx`, base64 |
| `WIN_CSC_KEY_PASSWORD` | Windows | Its password |

See [desktop.md](desktop.md#signing-and-notarization) for how to get them. Nothing else changes when you add them:
the next tag produces signed (and, with the API key, notarized) installers.

## Adding a workspace package

`glimpse-ui` is published as one bundle: `packages/cli/scripts/bundle.mjs` inlines every `@glimpse/*` package with
esbuild and leaves third-party packages as imports. So when a new workspace package (say `@glimpse/react`) is used
by the CLI:

1. add it to `packages/cli/package.json` **devDependencies** (`"@glimpse/react": "workspace:*"`), never
   dependencies;
2. add its third-party runtime dependencies to `packages/cli/package.json` **dependencies**, with the same ranges;
3. add the same to `apps/desktop/package.json` dependencies and run `npm install` there.

`pnpm build` fails with the exact lines to add if step 2 is missed (it reads the bundled packages' `package.json`
files, transitively, and the imports esbuild actually left in the bundle), and the desktop build fails if step 3
is missed.
