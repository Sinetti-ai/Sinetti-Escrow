import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { expect } from "chai";

import {
  buildDeliveryStatement,
  buildSubject,
  canonicalJson,
  deliveryStatementDigest,
  hashFile,
  sha256Hex,
  toBytes32
} from "../src/evidenceManifest";
import {
  verifySchemaDelivery,
  type AcceptanceCriteria,
  type EvidenceEnvelope,
  type SchemaVerificationJob,
  VERIFIER_VERSION
} from "../src/verifier";

describe("deterministic schema verifier", function () {
  let root: string;

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "sinetti-verifier-"));
  });

  afterEach(async function () {
    await rm(root, { recursive: true, force: true });
  });

  async function jobFor(artifact: unknown): Promise<SchemaVerificationJob> {
    const caseRoot = await mkdtemp(path.join(root, "case-"));
    const artifactRoot = path.join(caseRoot, "artifact");
    await mkdir(artifactRoot);
    await writeFile(path.join(artifactRoot, "customer-export.json"), JSON.stringify(artifact));
    const logsPath = path.join(caseRoot, "verification.log");
    await writeFile(logsPath, "schema validation completed\n");
    const runtimeHash = hashFile(path.resolve("package-lock.json"));
    const repoCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const statement = buildDeliveryStatement({
      subject: buildSubject(artifactRoot),
      repoCommitHash: repoCommit,
      runtimeHash,
      logsHash: hashFile(logsPath)
    });
    const artifactHash = deliveryStatementDigest(statement);
    const criteria: AcceptanceCriteria = {
      acceptance_criteria_id: "crit_schema_fixture",
      acceptance_type: "schema_validity",
      verification_method: "deterministic",
      evidence_required: ["artifact", "repo_commit_hash", "runtime_hash", "test_log"],
      auto_release_threshold: "schema_valid",
      schema_or_test_ref: "schemas/customer-export.schema.json",
      artifact_path: "customer-export.json",
      schema_hash: hashFile(path.resolve("schemas/customer-export.schema.json")),
      repo_commit_hash: repoCommit,
      runtime_hash: runtimeHash,
      verifier_version: VERIFIER_VERSION,
      created_at: "2026-09-01T00:00:00Z"
    };
    const envelope: EvidenceEnvelope = {
      evidence_id: "ev_schema_fixture",
      agreement_id: "agr_schema_fixture",
      artifact_ref: "operator-push:artifact",
      artifact_hash: artifactHash,
      logs_ref: "operator-push:verification.log",
      statement,
      submitted_by: "fixture-seller",
      submitted_at: "2026-09-01T00:01:00Z",
      signature: "bound-by-on-chain-seller-submission"
    };
    return {
      criteria,
      envelope,
      artifactRoot,
      logsPath,
      onChainEvidenceHash: toBytes32(artifactHash),
      onChainTermsHash: toBytes32(sha256Hex(canonicalJson(criteria))),
      verifiedAt: "2026-09-01T00:02:00Z"
    };
  }

  it("passes a fully bound artifact that satisfies the committed schema", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );
    expect(verifySchemaDelivery(await jobFor(artifact))).to.include({
      result: "pass",
      reason_code: "tests_passed"
    });
  });

  it("rejects a caller's attempt to substitute verifier provenance", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );
    const job = await jobFor(artifact);
    job.criteria.schema_hash = "0".repeat(64);
    job.onChainTermsHash = toBytes32(sha256Hex(canonicalJson(job.criteria)));
    expect(verifySchemaDelivery(job)).to.include({ result: "fail", reason_code: "evidence_missing" });

    const runtimeSwap = await jobFor(artifact);
    runtimeSwap.criteria.runtime_hash = "1".repeat(64);
    runtimeSwap.envelope.statement.predicate.runtime_hash = "1".repeat(64);
    runtimeSwap.onChainTermsHash = toBytes32(sha256Hex(canonicalJson(runtimeSwap.criteria)));
    runtimeSwap.envelope.artifact_hash = deliveryStatementDigest(runtimeSwap.envelope.statement);
    runtimeSwap.onChainEvidenceHash = toBytes32(runtimeSwap.envelope.artifact_hash);
    expect(verifySchemaDelivery(runtimeSwap)).to.include({ result: "fail", reason_code: "evidence_missing" });
  });

  it("fails an intact artifact that does not satisfy the committed schema", async function () {
    expect(verifySchemaDelivery(await jobFor({ rows: [] }))).to.include({
      result: "fail",
      reason_code: "schema_invalid"
    });
  });

  it("rejects evidence and criteria substitutions before evaluating the artifact", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );
    const job = await jobFor(artifact);
    job.criteria.artifact_path = "another.json";
    expect(verifySchemaDelivery(job)).to.include({
      result: "fail",
      reason_code: "evidence_missing"
    });

    const bound = await jobFor(artifact);
    await writeFile(path.join(bound.artifactRoot, "customer-export.json"), "{}\n");
    expect(verifySchemaDelivery(bound)).to.include({
      result: "fail",
      reason_code: "evidence_missing"
    });
  });

  it("refuses artifact and schema paths outside their configured roots", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );

    const escapedArtifact = await jobFor(artifact);
    escapedArtifact.criteria.artifact_path = "../customer-export.json";
    escapedArtifact.onChainTermsHash = toBytes32(
      sha256Hex(canonicalJson(escapedArtifact.criteria))
    );
    expect(verifySchemaDelivery(escapedArtifact)).to.include({
      result: "inconclusive",
      reason_code: "runtime_error"
    });

    const escapedSchema = await jobFor(artifact);
    escapedSchema.criteria.schema_or_test_ref = "../outside.schema.json";
    escapedSchema.onChainTermsHash = toBytes32(
      sha256Hex(canonicalJson(escapedSchema.criteria))
    );
    expect(verifySchemaDelivery(escapedSchema)).to.include({
      result: "inconclusive",
      reason_code: "runtime_error"
    });
  });

  it("enforces the date-time format instead of treating it as always valid", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );
    for (const bad of ["not-a-date", "2026-02-30T00:00:00Z", "2026-01-14T24:00:00Z", "2026-01-14 10:30:00Z"]) {
      expect(verifySchemaDelivery(await jobFor({ ...artifact, generated_at: bad })), bad).to.include({
        result: "fail",
        reason_code: "schema_invalid"
      });
    }
    for (const good of ["2026-01-14T10:30:00Z", "2026-01-14T10:30:00.123+01:00", "2024-02-29T23:59:59-05:00"]) {
      expect(verifySchemaDelivery(await jobFor({ ...artifact, generated_at: good })), good).to.include({
        result: "pass"
      });
    }
  });

  it("reports unavailable logs as inconclusive rather than seller failure", async function () {
    const artifact = JSON.parse(
      await readFile(path.resolve("examples/delivery/customer-export.json"), "utf8")
    );
    const job = await jobFor(artifact);
    job.logsPath = path.join(root, "missing-verification.log");
    expect(verifySchemaDelivery(job)).to.include({
      result: "inconclusive",
      reason_code: "evidence_missing"
    });
  });
});
