# Contributing to Sinetti

This repository contains an early, unaudited implementation with no supported
public deployment. Start with [README.md](README.md), the
[roadmap](ROADMAP.md), and [SECURITY.md](SECURITY.md).

Fork the repository and open a pull request from a branch in your fork. Sign
off every commit with the Developer Certificate of Origin (`git commit -s`),
which adds a `Signed-off-by` line certifying that you have the right to submit
the change under the project licence; see <https://developercertificate.org>.
Pull requests without sign-off on every commit are not merged. Participation is
governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); how decisions are made is
in [GOVERNANCE.md](GOVERNANCE.md).

Keep each change small and reviewable. Preserve tested protocol behavior unless
the change deliberately revises it, preserve required license and attribution
notices, and include the tests and fixtures needed to support every new claim.

Use Node.js 22 and Foundry v1.7.1. Before opening a pull request, run:

```sh
npm ci
npm run check:dependencies
npm run check:publication
npm run build
npm run typecheck
npm test
npm run validate:schemas
```

CI also runs the examples, Slither policy check, current dependency advisory
check, source-hygiene checks, and secret scanning. A contribution intentionally
submitted for inclusion is provided under Apache-2.0, as described in
[LICENSE](LICENSE), unless it is explicitly designated otherwise.

Do not copy private handoffs, credentials, production configuration, case data,
operator state, or internal commercial material into this repository. Use pull
requests rather than committing implementation directly to `main`.

Report security findings through the route described in
[SECURITY.md](SECURITY.md), not through a public issue.
