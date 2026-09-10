import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020";

import {
  buildSubject,
  canonicalJson,
  deliveryStatementDigest,
  hashFile,
  sha256Hex,
  toBytes32,
  type DeliveryStatement
} from "./evidenceManifest";

export const VERIFIER_VERSION = "sinetti-schema-verifier/0.1.0";

export type AcceptanceCriteria = {
  acceptance_criteria_id: string;
  acceptance_type: string;
  verification_method: string;
  evidence_required: string[];
  auto_release_threshold: string;
  schema_or_test_ref: string;
  artifact_path?: string;
  schema_hash?: string;
  repo_commit_hash?: string;
  runtime_hash?: string;
  verifier_version?: string;
  created_at: string;
};

export type EvidenceEnvelope = {
  evidence_id: string;
  agreement_id: string;
  artifact_ref: string;
  artifact_hash: string;
  logs_ref: string;
  statement: DeliveryStatement;
  submitted_by: string;
  submitted_at: string;
  signature: string;
};

export type VerificationResult = {
  verification_id: string;
  agreement_id: string;
  evidence_id: string;
  result: "pass" | "fail" | "inconclusive";
  reason_code:
    | "tests_passed"
    | "schema_invalid"
    | "evidence_missing"
    | "timeout"
    | "runtime_error";
  verifier_version: string;
  verified_at: string;
};

export type SchemaVerificationJob = {
  criteria: AcceptanceCriteria;
  envelope: EvidenceEnvelope;
  artifactRoot: string;
  logsPath: string;
  onChainEvidenceHash: string;
  onChainTermsHash: string;
  verifiedAt?: string;
};

function repositoryRoot(): string {
  let cursor = path.resolve(__dirname);
  while (true) {
    const manifest = path.join(cursor, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name === "sinetti") return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("cannot locate the running Sinetti checkout");
    cursor = parent;
  }
}

function runningCommit(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function inside(root: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) throw new Error(`${label} must be relative`);
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  const fromBase = path.relative(base, resolved);
  if (fromBase === ".." || fromBase.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes its configured root`);
  }
  return resolved;
}

function result(
  job: SchemaVerificationJob,
  status: VerificationResult["result"],
  reason: VerificationResult["reason_code"]
): VerificationResult {
  return {
    verification_id: `ver_${job.envelope.artifact_hash.slice(0, 16)}`,
    agreement_id: job.envelope.agreement_id,
    evidence_id: job.envelope.evidence_id,
    result: status,
    reason_code: reason,
    verifier_version: VERIFIER_VERSION,
    verified_at: job.verifiedAt ?? new Date().toISOString()
  };
}

// RFC 3339 date-time: full date, "T", time with optional fraction, then "Z" or an
// hh:mm offset. The calendar round-trip rejects impossible days such as 2026-02-30,
// which Date.parse alone accepts.
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 && minute < 60 && second < 60
  );
}

// `date-time` is the only JSON Schema `format` this verifier implements. Ajv runs in
// strict mode, so a committed schema using any other `format` fails to compile and the
// job is Inconclusive rather than silently accepted.
function schemaValidator(schema: unknown) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { "date-time": isRfc3339DateTime }
  });
  return ajv.compile(schema as object);
}

export function verifySchemaDelivery(job: SchemaVerificationJob): VerificationResult {
  try {
    if (
      job.criteria.acceptance_type !== "schema_validity" ||
      job.criteria.verification_method !== "deterministic"
    ) {
      return result(job, "inconclusive", "runtime_error");
    }
    if (
      !job.criteria.artifact_path ||
      !job.criteria.schema_hash ||
      !job.criteria.repo_commit_hash ||
      !job.criteria.runtime_hash ||
      job.criteria.verifier_version !== VERIFIER_VERSION
    ) return result(job, "fail", "schema_invalid");

    const repoRoot = repositoryRoot();

    const criteriaSchema = JSON.parse(
      readFileSync(path.resolve(__dirname, "../schemas/acceptance-criteria.schema.json"), "utf8")
    );
    const envelopeSchema = JSON.parse(
      readFileSync(path.resolve(__dirname, "../schemas/evidence-envelope.schema.json"), "utf8")
    );
    if (!schemaValidator(criteriaSchema)(job.criteria) || !schemaValidator(envelopeSchema)(job.envelope)) {
      return result(job, "fail", "schema_invalid");
    }

    const criteriaHash = toBytes32(sha256Hex(canonicalJson(job.criteria)));
    if (criteriaHash.toLowerCase() !== job.onChainTermsHash.toLowerCase()) {
      return result(job, "fail", "evidence_missing");
    }

    const digest = deliveryStatementDigest(job.envelope.statement);
    const chainHash = job.onChainEvidenceHash.toLowerCase().replace(/^0x/, "");
    if (digest !== job.envelope.artifact_hash || digest !== chainHash) {
      return result(job, "fail", "evidence_missing");
    }
    if (
      job.envelope.statement.predicate.repo_commit_hash !== job.criteria.repo_commit_hash ||
      job.envelope.statement.predicate.runtime_hash !== job.criteria.runtime_hash ||
      runningCommit(repoRoot) !== job.criteria.repo_commit_hash ||
      hashFile(path.join(repoRoot, "package-lock.json")) !== job.criteria.runtime_hash
    ) {
      return result(job, "fail", "evidence_missing");
    }
    if (!existsSync(job.logsPath)) return result(job, "inconclusive", "evidence_missing");
    if (hashFile(job.logsPath) !== job.envelope.statement.predicate.logs_hash) {
      return result(job, "fail", "evidence_missing");
    }

    const actualSubject = buildSubject(job.artifactRoot);
    if (canonicalJson(actualSubject) !== canonicalJson(job.envelope.statement.subject)) {
      return result(job, "fail", "evidence_missing");
    }

    const artifactPath = inside(job.artifactRoot, job.criteria.artifact_path, "artifact_path");
    const schemaPath = inside(repoRoot, job.criteria.schema_or_test_ref, "schema_or_test_ref");
    if (!existsSync(artifactPath) || !existsSync(schemaPath)) {
      return result(job, "inconclusive", "evidence_missing");
    }
    if (hashFile(schemaPath) !== job.criteria.schema_hash) {
      return result(job, "fail", "evidence_missing");
    }

    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    return schemaValidator(schema)(artifact)
      ? result(job, "pass", "tests_passed")
      : result(job, "fail", "schema_invalid");
  } catch {
    return result(job, "inconclusive", "runtime_error");
  }
}
