# Publishing pi-cache-keeper to npm

**Status: live.** A push to `main` whose version npm doesn't have publishes it: `.github/workflows/publish.yml`
checks, packs, loads and tests that version, publishes that archive through npm's trusted publisher (no token), with
provenance, then tags it and makes its GitHub release. The dry-run switch is off. 0.10.2, the first version, was
published by hand; 0.10.3 is the first the workflow published, and the first with provenance
([The owner's one-time steps](#the-owners-one-time-steps)).

The workflow is pi-provimux's `publish.yml` (its `docs/FOLLOWING.md`, 4), cut down to publishing: there is no
upstream to follow, so no `follow.yml`, no merge, no guard on someone else's changes.

## What the package holds

`files` in `package.json`: the top-level `.ts` modules (what Pi loads; `index.ts` is the one `pi.extensions` names,
and it imports the others), `README.md`, `CHANGELOG.md` and `LICENSE`; npm adds `package.json`. Not shipped: the
tests and their fixtures, `docs/`, `design/`, `media/`, `tsconfig.json`. `npm pack --dry-run` lists 17 files.

The package has no runtime dependencies: Pi provides everything it imports (`@earendil-works/pi-*`, as
`peerDependencies`). It has no install scripts.

## The workflow

`publish.yml` publishes **the version `main` names, if npm doesn't have it**. It reads state, not events, so a rerun
is always safe. Started by a push to `main`, or by hand:
`gh workflow run publish.yml -R ngvoicu/pi-cache-keeper --ref main -f dry_run=no` (or `yes`). One run at a time.

| Job | What it does | Permissions |
|---|---|---|
| `plan` | `publish.sh plan`: names `main`'s version; refuses an `.npmrc` in the tree before npm runs; asks npm (from a neutral folder, no configuration) whether it has the version. If not, the guard: the name, `repository.url` exactly `git+https://github.com/ngvoicu/pi-cache-keeper.git` (trusted publishing requires it), no `private`, `publishConfig` absent or `{"access": "public"}`, no runtime dependencies, a plain `X.Y.Z` greater than npm's `latest`, a `## [X.Y.Z]` heading in the changelog, no lifecycle script, and a tarball of tracked files only: top-level `.ts` modules and the four files, with every extension `pi.extensions` registers. | `contents: read` |
| `test` | Writes the commit's tree with `git checkout-index` (no `.git`). In a container (`node:24.22.3-bookworm-slim`, pinned by digest) given that tree and the network, nothing of the runner: `npm pack` of the clean tree before anything is installed; on the runner, the archive's sha512 recorded and the archive uploaded as `publish-archive`; then in the container `npm install` of the dev dependencies (the repository keeps no lockfile; `package.json` pins Pi's packages exactly), the archive loaded by Pi's own loader (`load.mjs`: extracted as npm installs it, only the peers linked in, a fresh `HOME` and agent folder, `PI_OFFLINE` set), and `npm run check`. | `contents: read` |
| `publish` | Takes the archive `test` packed, loaded and checked (`publish.sh archive`: by the artifact's id and digest, its sha512 the recorded one, its files exactly what npm packs from the commit, byte for byte). Then in one step: the sha512 again, a clean checkout, the live `main` still that commit, and `npm publish --ignore-scripts --access public` of that archive. No install, no script, no pack. | `id-token: write`, `contents: read`, `actions: read`; environment `npm` |
| `tag` | `v<version>` at the published commit, which must be in the live `main` and name the version, and the GitHub release with the changelog's entry. When npm already had the version (a version published by hand, or a run that died after the upload): the commit npm recorded (`gitHead`), else an existing tag, each only at a commit of the live `main` that names the version. Tags are never moved. | `contents: write`; environment `main-only` |
| `notify` | After a failure: the issue `publish: <version> — failed` (label `publish-bot`). After a live success, once npm shows the version (it is asked every 30 s for up to 15 minutes), closes that issue. A dry run closes nothing. | `issues: write`; environment `main-only` |

Every job runs only on github.com and only from `refs/heads/main`, checked by the shell first. The two environments
admit the branch `main` alone, so GitHub refuses the jobs that write or hold the OIDC token from any other ref.
Neither has a secret or a reviewer. Every action is GitHub's own, pinned by commit; the Node version is 24 (npm 11.5.1
or later, which trusted publishing needs; the `publish` job checks it). No `registry-url` for `setup-node`: the
`.npmrc` it would write gets in the way of OIDC. The NAS mirror never runs these jobs: each one requires
`github.server_url` to be `https://github.com`.

### The dry-run switch

`publish.yml` has the input `dry_run` and the line `DRY_RUN: ${{ inputs.dry_run || 'yes' }}`. A push has no input and
takes the fallback. **Both say `'no'` since 0.10.3** (they said `'yes'` before): a push publishes, and a run by hand
can still choose `dry_run=yes`. In a dry run every check runs, and `publish` runs
`npm publish --dry-run` on the tested archive with `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and
`NPM_ID_TOKEN` removed from its environment, so npm exchanges no token and uploads nothing; `tag` says which tag and
release it would make.

**The switch** is one commit: in `publish.yml`, `default: 'yes'` ("the switch (1 of 2)") and
`inputs.dry_run || 'yes'` ("the switch (2 of 2)") become `'no'`. It was made after 0.10.3, the first version
published by this workflow (step 5 below). To put the dry run back, the same two lines back to `'yes'`.

A version this workflow publishes goes up as the tested archive, so npm records no `gitHead` for it (0.10.3 has
none). A later run that finds the version already on npm (a push that leaves the version alone, a rerun, a run by hand)
publishes nothing, and its `tag` job takes the existing tag `v<version>` instead, which the publishing run made.

## Making a release

Raise `version` in `package.json` (`npm version patch --no-git-tag-version`), add the `## [X.Y.Z] - date` entry to
`CHANGELOG.md`, commit, push `main` to GitHub and the NAS. The push to GitHub publishes it. A push that
leaves the version alone publishes nothing (Git installs still get it).

A bad version is fixed by a greater one: Pi installs a version only when it is greater than the installed one.
`npm deprecate pi-cache-keeper@<bad> "…"` marks the bad one.

## The first version: what npm requires

Read on 2026-11-23.

- **A trusted publisher is set on a package that already exists.** The `npm trust` page lists among its
  prerequisites: "**Package must exist**: The package you're configuring must already exist on the npm registry."
  ([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)). On the website, the trusted-publishing guide's
  first step is to "Navigate to your package settings on npmjs.com and find the "Trusted Publisher" section"
  ([Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)): a package that doesn't exist
  has no settings page. npm has no "pending" publisher for a name not yet taken, as PyPI has; npm's documentation
  issue asking how a first publish should be done is open, with no answer from npm
  ([npm/documentation#1926](https://github.com/npm/documentation/issues/1926)).
- **So the first version is published another way: by hand.** No token is needed for that: the owner signs in with
  `npm login` and 2FA and runs `npm publish` himself. That version has no provenance; every version the workflow
  publishes has it ("When you publish using trusted publishing from GitHub Actions or GitLab CI/CD, npm automatically
  generates and publishes provenance attestations", for a public package from a public repository).
- **Staged publishing does not avoid it.** `npm stage publish` works for a new name, but "When you stage a package
  that does not yet exist, npm publishes a placeholder version of the package with the version `0.0.0-stage`. This
  placeholder version is publicly available" ([Staged publishing](https://docs.npmjs.com/staged-publishing)), and it
  still needs the owner's login: a by-hand step either way, with a stray public version besides.
- **A new trusted publisher must be used within 2 days:** "A newly created trusted publisher configuration must
  complete its first successful publish within 2 days … If the configuration is not validated within 2 days, it
  expires and can no longer be used or edited." So it is created on the day the next version is ready.
- **What it names:** the user `ngvoicu`, the repository `pi-cache-keeper`, the workflow file `publish.yml` (the name
  only), the environment `npm`; all case-sensitive, and "npm does not verify your trusted publisher configuration
  when you save it". Publishers created after 2026-09-03 allow only `npm stage publish` unless `npm publish` is ticked
  ("Allowed actions"); automatic publishing needs it ticked.
- **Requirements of the run:** npm CLI 11.5.1 or later and Node 22.14.0 or later, `id-token: write`, a GitHub-hosted
  runner, and `repository.url` matching the repository exactly.

## The owner's one-time steps

The GitHub environments `npm` and `main-only` (each admitting the branch `main` alone) were made with 0.10.2. Nothing
is stored on GitHub: no secret, no token. Steps 1 to 5 were done on 2026-11-23; step 6 is the owner's.

1. **npm account.** The account that publishes pi-provimux, with two-factor authentication on. On the Mac:
   `npm login` (`npm whoami` shows the account).
2. **The first publish, by hand,** of 0.10.2, from a fresh clone of the commit the chief names:
   ```sh
   git clone https://github.com/ngvoicu/pi-cache-keeper.git /tmp/pi-cache-keeper-first
   cd /tmp/pi-cache-keeper-first && git checkout <the commit>
   npm publish --ignore-scripts --access public
   npm view pi-cache-keeper version
   ```
   npm asks for the second factor. Then tell the chief: `gh workflow run publish.yml -R ngvoicu/pi-cache-keeper
   --ref main -f dry_run=no` finds 0.10.2 on npm and only makes the tag `v0.10.2` and its release, at the commit npm
   recorded (`gitHead`); if npm recorded none, the run fails and says so, and the tag is made by hand.
3. **The trusted publisher, on the day the next version is ready** (it expires unused after 2 days): npmjs.com →
   pi-cache-keeper → Settings → Trusted Publisher → GitHub Actions: organization or user `ngvoicu`, repository
   `pi-cache-keeper`, workflow filename `publish.yml`, environment name `npm`; under allowed actions tick
   `npm publish`. Or on the Mac (npm 11.15 or later):
   ```sh
   npm trust github pi-cache-keeper --file publish.yml --repo ngvoicu/pi-cache-keeper --env npm --allow-publish
   npm trust list pi-cache-keeper
   ```
4. **The first publish by the workflow:** the next version (0.10.3) is pushed to `main` (the push only
   dry-ran), then `gh workflow run publish.yml -R ngvoicu/pi-cache-keeper --ref main -f dry_run=no` publishes it,
   within the 2 days. Its page on npmjs.com shows "Provenance" with the commit. Done: 0.10.3.
5. **The switch** off, in a commit of its own ([The dry-run switch](#the-dry-run-switch)): from then on a push
   publishes. Done, after 0.10.3.
6. **No more tokens:** npmjs.com → pi-cache-keeper → Settings → Publishing access → "Require two-factor
   authentication and disallow tokens" → Update Package Settings. Trusted publishing keeps working.
