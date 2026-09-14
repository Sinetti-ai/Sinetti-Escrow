# Security

## Current status

This repository contains an early protocol and reference role implementations.
It does not contain a supported release or supported deployment.

No Sinetti contract or service described here should be considered audited,
production-ready, or safe for real funds. Public testnet deployments, when added,
will remain experimental and will be documented with their exact versions,
addresses, limitations, and available security evidence.

## Supported versions

There are currently no supported versions.

Security support and end-of-support information will be published with the first
supported release.

## Security contacts

The maintainers listed in [MAINTAINERS.md](MAINTAINERS.md) form the security
team and receive private reports.

## Reporting a vulnerability

Use GitHub private vulnerability reporting from this repository's **Security**
tab. Do not open a public issue containing vulnerability details. Enabling and
verifying that repository setting is a publication gate; if the private-report
button is absent, publication is not complete.

Maintainers aim to acknowledge a report within three business days and provide
an initial assessment within seven business days. Please coordinate public
disclosure with the maintainers until a fix or agreed disclosure date is ready.

There is currently no bug-bounty program, and no additional safe-harbor terms
are offered by this policy.

## V0 trust boundaries

The implementation and threat model must account for at least these boundaries:

- **Buyer and seller keys:** signatures authorize deal terms and state changes;
  compromised keys can authorize actions on behalf of their holders.
- **Party-selected verifier:** every deal names a verifier address accepted by
  its parties. That verifier can record a result, which remains subject to the
  contract's challenge path. Parties must assess the selected verifier's code,
  operator, availability, and incentives.
- **Party-selected arbitrator:** every deal names an arbitrator contract accepted
  by its parties. Its code, signer model, deadlines, and authority determine the
  challenged outcome and must be assessed before funding.
- **Untrusted inputs:** acceptance tests, delivery artifacts, evidence, logs, and
  metadata may be malicious, mutually untrusted, or crafted to exhaust resources.
- **Service availability:** verifier or arbitration outages must resolve through
  explicit deadlines and recovery paths without silently assigning substantive
  fault to a party.
- **Signed windows:** the contract's 60-second absolute floors exist for local
  demonstrations, not as recommended public settings. A deployment must choose
  challenge and ruling windows that account for monitoring delay, operator
  response, chain congestion, censorship, and recovery before participants fund
  deals.
- **Public chain data:** transaction contents and committed hashes are public and
  permanent; private or secret material must not be placed on-chain.
- **Role-provider infrastructure:** Sinetti expects to operate initial reference
  instances. Each instance's isolation, queues, signers, case data, monitoring,
  and anti-abuse controls require a deployment-specific review. Publishing the
  role logic does not make an instance production-safe.

## Dependencies

The only runtime dependency is `@openzeppelin/contracts`, pinned in
`package.json`. Every other npm package is build and test tooling (Hardhat 3 and
its plugins, mocha, chai, typechain, tsx). Dependabot alerts against that tooling
do not reach the compiled contracts or anyone who deploys them. Maintainers triage
them by hand; the open set is recorded in SUPPLY-CHAIN.md. A runtime dependency alert is handled as a security report.

## Claims and verification

Security properties do not automatically transfer between implementations.
Contract privileges, pausing behavior, fund movement, fees, caps, timeout
outcomes, and arbitration behavior must be verified against the exact published
source and tests before they are documented as guarantees.

Audit, formal-verification, production-safety, and mainnet-readiness claims must
link to evidence that applies to the exact published version. Absence of a known
vulnerability is not evidence that a release is safe.
