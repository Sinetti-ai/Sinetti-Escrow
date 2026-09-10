# Governance

Sinetti Escrow is an open protocol component under the Apache-2.0 licence. This
document says who decides what, and how a contributor becomes a maintainer. It
is written to fit the LF Decentralized Trust project lifecycle.

## Roles

**Contributors** are anyone who opens an issue or a pull request. Every
contribution needs a Developer Certificate of Origin sign-off
(`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md).

**Maintainers** hold write access, review and merge changes, cut releases, and
answer for the security and conduct routes. The current list is
[MAINTAINERS.md](MAINTAINERS.md).

## Decisions

Decisions are made in public, in this repository.

- Ordinary changes land by pull request with at least one maintainer approval
  from someone other than the author. Contract, security-policy, and release
  changes must carry the tests and evidence needed to support their claims.
- Larger questions (protocol changes, release scope, governance changes,
  adding or removing a maintainer) are proposed in an issue or pull request and
  decided by lazy consensus: if no maintainer objects within 72 hours, the
  proposal carries. An objection turns it into a vote, decided by a simple
  majority of active maintainers, recorded in the same thread.
- A maintainer may merge an urgent security fix before public discussion and
  must document the decision once coordinated disclosure permits it.
- While fewer than two named maintainers are listed, the listed maintainers
  decide by consensus and record the decision in the thread; the majority and
  other-than-author rules apply from the second named maintainer onward.

## Becoming a maintainer

A contributor with a record of sound reviews and sustained contributions may be
nominated by any maintainer in a pull request that adds them to
[MAINTAINERS.md](MAINTAINERS.md). The nomination is open for at least one week
and carries by a simple majority of active maintainers. The project aims for
maintainers from more than one organisation and will prefer nominations that
widen that set.

## Stepping back

A maintainer may move to emeritus status at any time by pull request. Where a
maintainer has had no tracked activity in this repository for three months, the
other maintainers notify them; after six months any maintainer may open a pull
request moving them to emeritus status, open for at least one week, with the
maintainer mentioned. One three-month extension may be requested in that pull
request. Emeritus maintainers return to active status by resumed activity and
approval of the current maintainers. This follows the
[LF Decentralized Trust inactivity policy](https://lf-decentralized-trust.github.io/governance/governing-documents/inactivity/).

## Conduct and security

Conduct is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); maintainers not
involved in a report handle it. Vulnerabilities follow [SECURITY.md](SECURITY.md).

## Changing this document

By pull request under the larger-questions rule above.
