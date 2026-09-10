# Sinetti Escrow

[![License](https://img.shields.io/github/license/Sinetti-ai/Sinetti-Escrow)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Sinetti-ai/Sinetti-Escrow/badge)](https://scorecard.dev/viewer/?uri=github.com/Sinetti-ai/Sinetti-Escrow)

**Escrow and recourse for deals between AI agents.**

The escrow holds payment while agreed work is delivered, records the outcome of
verification, and resolves a challenged outcome before settlement. The contract
holds the funds; no operator can move them.

This repository is the escrow and recourse component of Sinetti, an open
protocol for trust between agents that have never met. The rest of Sinetti is at
[sinetti.ai](https://sinetti.ai).

## What Sinetti adds

Payment rails move value. They do not decide what happens when agreed work is
missing, broken, or disputed. Sinetti adds a deal lifecycle around the payment:

1. buyer and seller sign the terms and acceptance criteria;
2. the buyer funds the escrow;
3. the seller submits delivery evidence;
4. the verifier named in the deal records the result;
5. an unchallenged result finalizes after the review window; or
6. a challenged result goes to the arbitrator named in the deal before
   settlement.

Sinetti is not a wallet, chain, identity issuer, or general-purpose payment rail.
It is designed to compose with those systems.

## Project status

The V04 escrow, reference arbitrator, client, evidence modules, schemas, local
examples, reference verifier, and arbitration-operator components are present.
Reference contracts are deployed on the Sepolia testnet. Addresses, transaction
hashes, constructor arguments, receipts and the commands to reproduce the
on-chain checks are in [deployments/sepolia.json](deployments/sepolia.json):

| Contract | Address |
| --- | --- |
| `SinettiEscrowV04` | [`0x73862690E12621b3BC5749281CE4b23fe4a1695c`](https://sepolia.etherscan.io/address/0x73862690E12621b3BC5749281CE4b23fe4a1695c) |
| `ConsoleArbitrator` | [`0x713D92780c3Ccb3416FCD50468C18ABB5449B8C7`](https://sepolia.etherscan.io/address/0x713D92780c3Ccb3416FCD50468C18ABB5449B8C7) |

The code is unaudited and the deployment is testnet only. Do not use it or any
related deployment with real funds. See [SECURITY.md](SECURITY.md) and the
[roadmap](ROADMAP.md).

### Public receipts

Three synthetic deals were run on the escrow above with a test token. Deals 1
and 2 named an earlier arbitrator instance that was never called; deal 6 named
the arbitrator above. The key transactions below are on Sepolia and can be
checked without trusting this repository; the full sequences are in the
deployment file. Deals 3 to 5 were opened and challenged against the earlier
arbitrator instance during testing and are not receipts.

| Deal | Step | Block | Transaction |
| --- | --- | --- | --- |
| 1, completed lifecycle | opened | 11628649 | [0xb5ce…7b7a](https://sepolia.etherscan.io/tx/0xb5ced5b6283059592b827437bb4ba604f71c478ec2a7cc0bfca77c2f763f7b7a) |
| | verification recorded | 11628654 | [0x21bc…881b](https://sepolia.etherscan.io/tx/0x21bceeed12b6d81e49c5760dc34ac409cb6cb5c2823e791764ed5b2f5fda881b) |
| | settled, accepted | 11628655 | [0x0485…ee86](https://sepolia.etherscan.io/tx/0x0485dd736b4d306f3db8ee279ff03c1f7479ce099340cc8bc832948575b9ee86) |
| | seller withdrew | 11628656 | [0xde69…ef86](https://sepolia.etherscan.io/tx/0xde690555ba95a5db0e4663e6e81cba6b093b97f6eb8670f77dee7fe27ad6ef86) |
| 2, timeout | opened | 11628665 | [0xbb5f…bf2e](https://sepolia.etherscan.io/tx/0xbb5f573a7693d9aca9975cd63ceef3e5b5af7aaf77c1e1937674e5085132bf2e) |
| | settled, timeout | 11628693 | [0x4732…9e9d](https://sepolia.etherscan.io/tx/0x4732aaf0fd7d7e305d0bcc364dce4b9e564bc75036de2f5394f950092cad9e9d) |
| | buyer withdrew | 11628694 | [0xbecc…b60a](https://sepolia.etherscan.io/tx/0xbecca7287f7ddd31940feaee67c39f2b2afb02782848b9b87687b56598e0b60a) |
| | seller withdrew | 11628695 | [0x2fbb…190d](https://sepolia.etherscan.io/tx/0x2fbb8d680f30ff142fbe795f65392a8321021c485ac82a05ac202dab6bb5190d) |
| 6, dispute | opened | 11629822 | [0xc476…5c83](https://sepolia.etherscan.io/tx/0xc4765f367f9d797796508d905b5269aaa38c35210c12d744f43a9e47ba5a5c83) |
| | verification recorded | 11629827 | [0xa17c…17cf](https://sepolia.etherscan.io/tx/0xa17cbac18c152daa0168d729fea6dadb070cc901b4168ce35f93b4aee6a017cf) |
| | challenged by the buyer | 11629829 | [0x8d62…f8cb](https://sepolia.etherscan.io/tx/0x8d6233f0b4574a1b435dd158d91827c8a924ad7b1ecc2e3ac96fee8793dff8cb) |
| | officer ruled refund; bond slashed; settled | 11630433 | [0x1fd4…3832](https://sepolia.etherscan.io/tx/0x1fd460a75682c3c54a586028a4c6486f665a00bd71947d424daa13fa520c3832) |
| | buyer withdrew | 11630435 | [0x99d7…5de6](https://sepolia.etherscan.io/tx/0x99d79bf2e87a7de20ee73dcd0f6ab302a2444dafc0051582b13e7fb08e485de6) |

In deal 6 the arbitrator's agent key never landed a proposal inside its window,
so the officer ruled directly. That path is the point of the officer role.

## Local quick start

Requires Node.js 22 and Foundry v1.7.1.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run validate:schemas
npm run example
npm run example:dispute
npm run example:timeout
```

The examples use an ephemeral local Hardhat chain and require no RPC URL, keys,
faucet, hosted verifier, or arbitration service.

## Intended integration journey

The published reference contracts above carry this journey on Sepolia. An
integrator should be able to use the public client modules, command-line tools,
or examples to:

- inspect the supported network and contract addresses;
- prepare and sign a deal with explicit acceptance criteria;
- fund the deal with testnet assets;
- submit delivery evidence;
- read the verification result and challenge window; and
- observe finalization or an arbitrator ruling.

Every deal names a verifier address and arbitrator contract accepted by its
parties. Those roles are open protocol participants, not exclusive Sinetti
services. Normal integrators will not be expected to deploy a chain or run either
role themselves: they can select a compatible available provider when forming a
deal, and can select different providers for a later deal.
Sinetti expects to operate initial reference providers to help the network start.
Those instances will use the same published role logic and interfaces available
to other operators. No hosted endpoint is claimed until its address, source,
limitations, and example transactions have been checked and published.

## Protocol roles

The verifier evaluates the committed acceptance criteria and records a result.
The arbitrator resolves challenged results according to the signed terms. The
parties choose both roles for each deal and may choose different compatible roles
for another deal.

A verifier must distinguish an inability to execute a check from a substantive
failure of the delivery. The signed terms and selected roles must define the
retry, escalation, and timeout behavior; a technical error must not silently be
treated as seller failure.

The current reference `ConsoleArbitrator` uses `agentKey` as an operational
proposal signer and gives an `officer` a review window of at least 24 hours,
followed by an enforced one-hour minimum relay buffer. The name does not mean
that an autonomous agent decides disputes. This is a reference contract, not a
privileged or exclusive arbitration service.

## Public repository boundary

The public core includes the logic required to independently run or reproduce a
protocol role: contracts, verifier checks and submission, arbitration operator
tools, schemas, clients, tests, and security documentation.

Only instance-specific secrets and sensitive state stay private: signing keys,
RPC credentials, private case evidence, live host inventory, alert destinations,
backups, and incident records. Private operations must not contain a second,
unpublished scoring or settlement implementation. See
[DESIGN-NOTES.md](DESIGN-NOTES.md) and [ROADMAP.md](ROADMAP.md).

## Contributor journey

Contributors can run contract and schema tests, client tests, a local
ephemeral chain, and mock verifier and arbitrator components. Any local chain or
Docker-based harness is development and CI infrastructure, not a copy of the
production role-provider environment and not the public end-user journey.

The current implementation surface is:

| Path | Included content |
|---|---|
| [`contracts/`](contracts/) | V04 escrow, arbitrator interface/reference, and test mocks |
| [`schemas/`](schemas/) | Criteria, evidence, remedy, settlement, and verification schemas |
| [`src/`](src/) | Signing, lifecycle, evidence, verifier, and arbitration modules |
| [`scripts/`](scripts/) | Evidence, verifier, and arbitration commands |
| [`docs/`](docs/) | Protocol boundary, evidence, standards, and security documentation |
| [`examples/`](examples/) | Three ephemeral-chain examples with synthetic delivery evidence |
| [`test/`](test/) | Selected Hardhat tests plus an independent Foundry suite |

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

## Interoperability

Reputation, agent discovery, and runtime integrations - including ERC-8004 and
A2A - remain future interoperability work and are not part of the initial release.
Identity references are opaque values and do not claim that a wallet is a unique
person or organization. See [docs/standards/](docs/standards/).

## When to use it

Use a direct payment for an immediate, atomic exchange whose success is known at
payment time. Sinetti is for agreements whose outcome arrives later or may be
reasonably disputed, so payment needs evidence, a review window, and recourse.

## Project

- Releases: the current release is
  [v0.1.0](https://github.com/Sinetti-ai/Sinetti-Escrow/releases/tag/v0.1.0);
  [CHANGELOG.md](CHANGELOG.md) summarises each release and
  [RELEASE.md](RELEASE.md) says how releases are made, signed and verified.
- People and decisions: [MAINTAINERS.md](MAINTAINERS.md),
  [GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Using it somewhere? Add your organisation or project to
  [ADOPTERS.md](ADOPTERS.md) with a verifiable reference.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The dependency
inventory and release controls are documented in
[SUPPLY-CHAIN.md](SUPPLY-CHAIN.md).
