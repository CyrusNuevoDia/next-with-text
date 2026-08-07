# Publishing

Releases are driven by [changesets](https://github.com/changesets/changesets). Every user-facing change lands with a changeset (`bun changeset`); the version bump and publish happen later, either through GitHub Actions or locally.

## Normal flow (GitHub Actions)

`.github/workflows/release.yml` mirrors gpt-workflow's two-phase pattern:

1. **Version pass** — on push to `main`, if `.changeset/*.md` files exist, the workflow runs `bun changeset version`, commits the bump, pushes it, and re-dispatches itself with `release_sha=<that commit>`.
2. **Publish pass** — the dispatched run checks out exactly `release_sha`, re-runs the test suite, packs the tarball, and publishes to npm only if the registry doesn't already have that version (if it does, the tarball's sha512 must match the registry's `dist.integrity` — a mismatch fails the run). It then polls the registry until the artifact is visible and tags `v<version>`.

npm auth is **OIDC trusted publishing** — no token secret. One-time setup on npmjs.com (package → Settings → Trusted publisher): repository `CyrusNuevoDia/next-with-text`, workflow `release.yml`. This can only be configured after the package exists, so the first publish is local (below).

## Local publish (bootstrap, or when Actions is down)

One-time: `npm login` (needs the npm account + OTP).

```sh
bun changeset                 # if the pending change has no changeset yet
bun changeset version         # applies changesets: bumps package.json, writes CHANGELOG.md
bun install --lockfile-only   # sync bun.lock with the new version
bun run test                  # full suite must be green
git add -A && git commit -m "chore(release): bump next-with-text version"
npm publish                   # prepack runs the build; prompts for OTP
git tag "v$(jq -r .version package.json)"
git push origin main --tags
```

`npm publish` is idempotent-hostile (a version can never be replaced), so if it succeeds but a later step fails, don't retry the publish — just finish the tag/push steps. The Actions publish pass skips versions that already exist, so a local publish and a later workflow run don't conflict.

## What ships

`files` is `dist` + `src`: `dist/` holds the built entrypoints (`index.cjs`, `patch.cjs`, `route.js`) and `src/` ships because the `types` export conditions point at the TypeScript sources directly (Next typechecks them via the `types` condition, and TS-aware config loaders may compile `src/index.ts` itself — which is why the patch.cjs lookup checks both `dist/` and `src/../dist/`). Verify contents with `npm pack --dry-run` before a first-of-its-kind release.
