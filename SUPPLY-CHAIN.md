# Supply chain

This repository keeps its dependency surface reviewable and treats dependency
changes as release changes. This review covers the initial public-release tree
and includes the advisory remediation described below; it was performed on 2
September 2026, and the toolchain was reviewed again on 13 September 2026 after the
move to Hardhat 3; the counts below describe that second tree. Before
publication, the same checks must run against the exact
commit being published. This is evidence about one reviewed tree, not a claim
that future installs are safe.

## What ships and what builds

The contract source has one direct runtime dependency:

| Dependency | Purpose | Pin |
|---|---|---|
| `@openzeppelin/contracts` | ERC-20, signature, and contract security primitives | exact `5.0.2` |

The manifest classifies the JavaScript and TypeScript toolchain as
`devDependencies` because the package is private and is not published to npm.
That label does not mean the entire tree is test-only: Ethers, Ajv,
TypeScript/`tsx`, and their transitives are executed when an operator runs
the reference verifier or arbitration commands. Hardhat, its toolbox, Chai, and
the type packages support compilation and testing.

The supported runtime is Node 22, and the direct `@types/node` development
dependency is aligned to that major version. Some tools may retain their own
nested Node type version according to their published dependency ranges.

The current lockfile contains 292 package entries. Every resolved tarball has an
integrity hash and every resolved source uses `https://registry.npmjs.org/`; there
are no Git, file, or arbitrary URL package sources.

## Installation scripts

Two locked transitive packages declare installation scripts:

| Package | Version | Why present |
|---|---:|---|
| `esbuild` | `0.28.2` | Native binary behind `tsx`, the TypeScript loader used by Hardhat 3 and the operator scripts |
| `fsevents` | `2.3.3` | Optional filesystem events support on macOS |

`scripts/check-dependencies.mjs` pins this allowlist by package and version. A new
or changed installation script fails CI until it is reviewed here.

## Reviewed advisory remediation

Release preparation identified transitive `fast-uri@3.1.3` inside affected
ranges for published high-severity URI parsing advisories. The manifest now
overrides Ajv's compatible range to `fast-uri@3.1.7`, and the lockfile records
that repaired version. The tarball URL and integrity value must still be
exercised by `npm ci`, and the full test suite and live advisory check must pass
on the exact release commit before publication.

- [GHSA-qw65-cvwx-89v3](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)
- [GHSA-58mr-gqgx-xq4g](https://github.com/fastify/fast-uri/security/advisories/GHSA-58mr-gqgx-xq4g)

Mocha 11 depends on `serialize-javascript@6`, which sits inside the ranges of a
high-severity code execution advisory and a moderate CPU exhaustion advisory.
The manifest overrides it to `serialize-javascript@7.1.1`, the version Mocha 12
adopted; Hardhat's Mocha plugin still declares Mocha 11 as its peer, so the
override is the narrower change. The lockfile policy pins the repaired version.

- [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)
- [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v)

The blocking CI advisory gate runs
`npm audit --package-lock-only --omit=dev --audit-level=high`. It covers the
runtime dependency shipped with the contract source. The lockfile policy still
checks every development package's source, integrity hash, and installation
scripts, but a clean runtime audit must not be read as a clean audit of the
development toolchain.

The full-lockfile audit on 13 September 2026, after the move to Hardhat 3,
reports 13 development-toolchain findings, all low severity: the `@ethersproject`
v5 packages and `elliptic` that `hardhat-verify` still pulls in, and `diff` under
Mocha. The 40 findings through Hardhat 2, its toolbox and `ajv-cli` left with
those packages. Operators should still treat the JavaScript toolchain as
untrusted build input, use it only with synthetic data and development keys, and
review the open GitHub dependency alerts before changing or redistributing it. A
nearly clean toolchain audit is not evidence that the contract source is safe.

## License review

Lockfile metadata is predominantly MIT, ISC, BSD, Apache-2.0, and similarly
permissive licensing. The metadata also contains four BlueOak-1.0.0
packages, one Python-2.0 package (`argparse@2.0.1`), and one package with no
license field in the lockfile (`@nomicfoundation/ignition-ui`). The manifest labels these as
development dependencies, but that classification does not by itself establish
whether a package is executed by an operator or distributed in a particular
artifact. Upstream license files require review before packaging or
redistributing a JavaScript tool bundle. Lockfile metadata is an inventory aid,
not a substitute for reading the packages' license texts.

## Enforced controls

- `package-lock.json` is committed; CI installs with `npm ci`.
- `scripts/check-dependencies.mjs` rejects missing integrity hashes, non-registry
  package sources, and unreviewed installation scripts.
- CI blocks on current high-severity npm advisories in runtime dependencies.
- The complete development tree remains covered by the deterministic lockfile
  policy and GitHub dependency alerts, with its known advisory exposure recorded
  above.
- GitHub Actions are pinned by commit SHA; the Foundry toolchain, Python runtime,
  and top-level Slither version are pinned.
- The publication check rejects local paths and private-workspace references.
- Gitleaks is downloaded at a fixed version and verified by SHA-256 before use.
- Dependabot opens grouped weekly update pull requests for npm and GitHub
  Actions, with a seven-day cooldown on version updates (`.github/dependabot.yml`).
- The OpenSSF Scorecard runs on every push to `main` and weekly; the badge in
  the README links to the current report.
- Release checksums are signed with Sigstore keyless signing by the release
  workflow from the next tag onward; see [RELEASE.md](RELEASE.md).

Dependency changes must include the regenerated lockfile, an update to this record
when the reviewed surface changes, and passing contract, client, example, schema,
static-analysis, publication, and advisory checks.

This inventory and the deterministic policy script cover the npm lockfile.
Slither runs in its own job with a read-only GitHub token, no persisted checkout
credential, an exact Python runtime, and an exact top-level Slither version. The
job is not sandboxed from its checkout or network. Its transitive Python
dependencies are not currently locked with hashes, so the complete CI toolchain
is not fully reproducible. Foundry, Python, GitHub Actions, and PyPI packages
remain upstream executable inputs despite their version or commit pins.

## Limits

Integrity hashes detect changed downloads; they do not prove that an upstream
package is trustworthy. Advisory databases cover disclosed vulnerabilities, not
unknown defects or malicious maintainers. CI pinning and review reduce risk but do
not replace minimizing dependencies or reviewing code that handles keys, evidence,
signatures, and transactions.
