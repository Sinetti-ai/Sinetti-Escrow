# Reference verifier

The first reference verifier supports deterministic JSON Schema acceptance. It
does not call an LLM or fetch seller-selected URLs.

`src/verifier.ts` checks, in order:

1. the criteria and evidence envelope shapes;
2. the canonical criteria hash against the deal's on-chain `termsHash`;
3. the canonical evidence statement against the deal's `evidenceHash`;
4. the exact repository revision, lockfile runtime hash, and log digest;
5. completeness and SHA-256 of every regular delivered file; and
6. the committed artifact against the committed JSON Schema.

Schema evaluation runs Ajv in strict mode. `date-time` is the only `format` the
verifier implements, checked as RFC 3339 with a valid calendar date. Leap seconds
(`:60`) are rejected because the JavaScript runtime cannot represent them. A schema
that uses any other `format` fails to compile and the job is `Inconclusive`.

Missing or substituted evidence fails before the artifact is interpreted. An
unsupported method or internal execution error is `Inconclusive`, not seller
failure. The on-chain submit mode reads the deal itself and confirms that its
state, verifier, terms hash, and evidence hash match before signing.

The artifact and log locations in a job file are operator-local paths populated
by a bounded push/upload layer. This release intentionally has no network fetch
adapter: accepting arbitrary URLs would add SSRF, DNS-rebinding, redirect, size,
and timeout risks unrelated to the verification rules.

The seller's on-chain `submitDelivery` call binds the evidence hash to the seller
role. The envelope's display signature is not treated as an independent source
of authority after that chain binding.

For `schema_validity`, the signed criteria commit `schema_hash`,
`repo_commit_hash`, `runtime_hash`, and `verifier_version`. The verifier resolves
the schema inside its own running repository, hashes its own `package-lock.json`,
and reads its own Git HEAD. A submitted job cannot redirect those checks to a
caller-selected schema tree or expected revision.
