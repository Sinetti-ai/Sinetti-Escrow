# Releases

How a release of this repository is made, and how to check one.

## What a release is

A release is an annotated Git tag `vMAJOR.MINOR.PATCH` on `main` and the
matching GitHub release. The artifacts are the source archive that GitHub
produces for the tag, a `SHA256SUMS` file listing that archive's checksum, and a
Sigstore signature bundle over `SHA256SUMS`. Nothing is published to npm or a
container registry. On-chain deployments are separate events recorded in
`deployments/` with their commit hash; a release does not imply a deployment.

Version numbers follow semantic versioning. Before v1.0.0 a minor version may
change protocol behaviour; the changelog says when it does.

## Cutting a release

1. Confirm `main` is green in CI and `git status` is clean.
2. Update [CHANGELOG.md](CHANGELOG.md): move Unreleased items under the new
   version with the date. Set `version` in `package.json` to `X.Y.Z`.
3. Tag with a key that is registered on your GitHub account and shows as
   verified there: `git tag -s vX.Y.Z -m "Sinetti Escrow vX.Y.Z"`, then push
   the tag. The release step checks that verification and stops if the tag is
   unsigned or the key is unknown to GitHub.
4. The `release` workflow (`.github/workflows/release.yml`) runs on the tag. It
   builds the source archive with `git archive`, writes `SHA256SUMS`, signs it
   with `cosign sign-blob` using the workflow's GitHub OIDC identity (Sigstore
   keyless, no long-lived key), and creates the GitHub release with the
   archive, the checksums, and the signature bundle attached.
5. Check the release page shows the three files and that verification below
   passes.

## Verifying a release

```sh
TAG=vX.Y.Z
gh release download "$TAG" --repo Sinetti-ai/Sinetti-Escrow
sha256sum --check SHA256SUMS
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github.com/Sinetti-ai/Sinetti-Escrow/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A passing check shows that the checksums were produced by this repository's
release workflow on that tag, and that the archive matches them. It does not
show that the code is safe; see [SECURITY.md](SECURITY.md).

## Reproducing the build

Releases are source only. To reproduce what a release contains:

```sh
git clone https://github.com/Sinetti-ai/Sinetti-Escrow
cd Sinetti-Escrow && git checkout vX.Y.Z
npm ci && npm run build && npm test
```

## Signing history

v0.1.0 (2026-09-03) was published before this process existed and carries no
signature. Releases from the next tag onward are signed as described above.

## Scorecard

The `scorecard` workflow (`.github/workflows/scorecard.yml`) runs the OpenSSF
Scorecard on every push to `main` and weekly, and publishes the result. The
badge in the README links to the current report.
