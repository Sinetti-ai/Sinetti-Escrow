# Changelog

Human-readable summary of each release. The complete list of changes is in the
Git history and the GitHub release notes.

## Unreleased

- Toolchain: Hardhat 3 with `@nomicfoundation/hardhat-toolbox-mocha-ethers`; the
  project is an ES module, tests run on Mocha 11 and Chai 6, `tsx` replaces
  `ts-node` for the operator scripts and a small script replaces `ajv-cli`.
  Hardhat's own Solidity test runner is pointed away from `test/foundry`, which
  forge keeps running. The full toolchain audit drops from 40 findings to 13,
  all low. No contract change.
- Arbitrator: `ConsoleArbitrator.rule()` lets the officer settle a dispute
  without waiting out the review window. Redeployed on Sepolia as
  `0x713D92780c3Ccb3416FCD50468C18ABB5449B8C7`; the escrow is unchanged. This
  is a protocol behaviour change in the reference arbitrator.
- Deploy: public deploy script, Sepolia network config and deploy docs;
  examples can attach to a deployed escrow and run synthetic lifecycles;
  `officer-rule.ts` settles a live disputed deal; gas floor from
  `SINETTI_MIN_NATIVE`; deployment record for v0.1.0 contracts.
- Verifier: enforce RFC 3339 date-time instead of accepting any string; accept
  years 0 to 99; document leap-second rejection.
- CI: retry `npm audit` three times; allowlist deployment records for gitleaks.
- README names AI agents as the deal parties and lists the public Sepolia
  receipts for deals 1, 2 and 6; `llms.txt` added; receipts recorded in
  `deployments/sepolia.json`.
- Project files for shared governance: CODE_OF_CONDUCT, MAINTAINERS,
  GOVERNANCE, ADOPTERS, RELEASE, CHANGELOG; DCO sign-off required in
  CONTRIBUTING; Dependabot configuration; OpenSSF Scorecard workflow; release
  workflow that signs release checksums with Sigstore.

## v0.1.0, 2026-09-03

Initial public source release: V04 escrow, reference arbitrator, client,
evidence modules, schemas, reference verifier, arbitration-operator tools, three
ephemeral-chain examples, Hardhat and Foundry tests, security documentation.
Reference contracts deployed to Sepolia. Unaudited, testnet only.
Release: <https://github.com/Sinetti-ai/Sinetti-Escrow/releases/tag/v0.1.0>.
