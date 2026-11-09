# Security

## What protects you

The Denaria Agent Signer is **assumed compromisable**: by its supply chain, by the computer
it runs on, by a prompt injection against your agent, even by a compromised Denaria API.
None of these can take more than the **Grant** you signed with your Passkey allows: its
markets, largest order, leverage, pace and expiry are enforced on chain by your smart
account's policies. The key it holds cannot withdraw, send funds, or change your account's
security. Revoking the agent in the app (**Settings → Access & security → Agents**) ends it.

So the point of everything below is to make a tampered Signer hard to ship and easy to spot,
not to be the last line of defence.

## What is pinned

- **One file.** The package is `dist/denaria-agent-signer.mjs`, every dependency bundled in,
  only Node.js built-ins outside. Its `package.json` has no dependencies and no scripts:
  installing it fetches one tarball and runs nothing. It is not minified, so it can be read.
- **The version.** The install commands in the Denaria app and in this README name an exact
  version, never a range or `latest`.
- **The dependencies.** Exact versions in every `package.json`, and `pnpm-lock.yaml`
  (integrity hashes) for everything they pull in. The build installs with
  `--frozen-lockfile --ignore-scripts`.
- **No npm token.** npm accepts only this repository's `release.yml` through trusted
  publishing (GitHub OIDC); there is no long-lived publishing token on any laptop or in any
  secret. Publishing waits for the owner's approval (the `npm` environment).
- **The build.** Every GitHub Action is pinned to a commit. The release rebuilds from this
  repository and refuses to publish unless the file is byte-for-byte the one Denaria built in
  its monorepo (`RELEASE.json`, checked by `scripts/verify-release.mjs`); `check.yml` does the
  same on every push.

## How to verify a release

Take version `X.Y.Z` as an example.

1. **The file is the release's.** Download the package and hash the file:

   ```bash
   npm pack @denaria/agent-signer@X.Y.Z
   tar -xzf denaria-agent-signer-X.Y.Z.tgz package/dist/denaria-agent-signer.mjs
   shasum -a 256 package/dist/denaria-agent-signer.mjs
   ```

   It must equal `sha256` in `RELEASE.json` at tag `vX.Y.Z` and the `SHA256SUMS` of the GitHub
   release `vX.Y.Z`.

2. **npm provenance.** The package page on npmjs.com shows "Built and signed on GitHub
   Actions", linking to this repository, `release.yml` and the commit. In a project that
   installed it, `npm audit signatures` checks the registry signature and the provenance
   attestation.

3. **GitHub attestation.**

   ```bash
   gh attestation verify package/dist/denaria-agent-signer.mjs --repo denaria-finance/denaria-agent-signer
   ```

4. **Rebuild it yourself** (Node.js 22, pnpm 9):

   ```bash
   git clone --branch vX.Y.Z https://github.com/denaria-finance/denaria-agent-signer.git
   cd denaria-agent-signer
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm build
   node scripts/verify-release.mjs vX.Y.Z
   ```

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (**Security → Report a
vulnerability**). Please do not open a public issue. If you think a key or a Grant is being
misused, revoke the agent in the Denaria app first.
