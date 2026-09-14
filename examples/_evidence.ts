import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  buildDeliveryStatement,
  buildSubject,
  deliveryStatementDigest,
  hashFile,
  sha256Hex,
  toBytes32,
  type DeliveryStatement
} from "../src/evidenceManifest";

/**
 * The delivery every example submits, hashed the way a real one is.
 *
 * The examples used to hash a literal `{artifact: "customer-export.json",
 * content: "representative customer export"}`. That is a commitment to a
 * *description* of a delivery: the same 32 bytes went on chain for every deal,
 * they matched no file anyone could produce, and an arbitrator comparing the
 * delivered artifact against them learned nothing in either direction. What is
 * hashed here is the bytes of `examples/delivery/`, through the same module the
 * public tooling and `docs/evidence.md` check 1 use.
 */
export const DELIVERY_DIR = path.join(import.meta.dirname, "delivery");

/** The run log, which is a delivered file and also the `logs_hash` source. */
export const DELIVERY_LOG = path.join(DELIVERY_DIR, "export-run.txt");

/**
 * The revision the delivered files come from.
 *
 * `repo_commit_hash` names "the exact revision under test" (verifier-spec check
 * 3), and for these examples the delivered files are tracked in this repository,
 * so its HEAD is that revision. There is deliberately no fallback constant: a
 * placeholder here would reintroduce exactly the defect this module exists to
 * remove, in the one field a verifier uses to find the source.
 */
export function repoCommitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    throw new Error(
      "cannot read the repository HEAD, so the delivery statement has no " +
        "repo_commit_hash. Run the examples from a git checkout of this " +
        "repository rather than from an extracted archive."
    );
  }
}

/**
 * A fingerprint of the interpreter this delivery was produced under.
 *
 * A real seller fingerprints the agreed execution environment (a container
 * digest, a lockfile hash). An example has no agreed environment, so it commits
 * to the one fact about its runtime that is actually true and actually varies.
 */
export function runtimeHash(): string {
  return hashFile(path.resolve(import.meta.dirname, "../package-lock.json"));
}

export type ExampleDelivery = {
  statement: DeliveryStatement;
  /** `artifact_hash` in the envelope: bare lowercase hex. */
  digestHex: string;
  /** The same 32 bytes as `submitDelivery` takes them. */
  evidenceHash: string;
};

export function exampleDelivery(): ExampleDelivery {
  const statement = buildDeliveryStatement({
    subject: buildSubject(DELIVERY_DIR),
    repoCommitHash: repoCommitHash(),
    runtimeHash: runtimeHash(),
    logsHash: hashFile(DELIVERY_LOG)
  });
  const digestHex = deliveryStatementDigest(statement);
  return { statement, digestHex, evidenceHash: toBytes32(digestHex) };
}

/** Every delivered file and its digest, one per line, for example output. */
export function describeDelivery(delivery: ExampleDelivery): string {
  const files = delivery.statement.subject
    .map((s) => `    ${s.name}  sha256:${s.digest.sha256}`)
    .join("\n");
  return `  delivered files:\n${files}\n  evidenceHash: ${delivery.evidenceHash}`;
}

/**
 * The same delivery with one field of one row edited, hashed the same way.
 *
 * This is the check the evidence hash exists for, and the only place in the
 * examples where it does any work. The contract does not perform it: it stores
 * 32 bytes and never looks at them again. Whoever holds the delivered files in
 * a dispute performs it, and the comparison is only meaningful because the
 * on-chain value commits to the artifact bytes rather than to a description of
 * them. Everything outside the artifact is held identical here, so the digests
 * differ for exactly one reason.
 */
export function tamperedDelivery(
  original: ExampleDelivery
): { evidenceHash: string; change: string } {
  const temp = mkdtempSync(path.join(tmpdir(), "sinetti-tampered-"));
  try {
    cpSync(DELIVERY_DIR, temp, { recursive: true });
    const artifact = path.join(temp, "customer-export.json");
    const before = readFileSync(artifact, "utf8");
    const after = before.replace('"cus_4c98be", "SE", "standard"', '"cus_4c98be", "SE", "premium"');
    if (after === before) {
      throw new Error(
        "the row this example edits is no longer in customer-export.json, so " +
          "nothing was tampered with and the comparison below would pass for " +
          "the wrong reason"
      );
    }
    writeFileSync(artifact, after);

    const statement = buildDeliveryStatement({
      subject: buildSubject(temp),
      repoCommitHash: original.statement.predicate.repo_commit_hash,
      runtimeHash: original.statement.predicate.runtime_hash,
      logsHash: original.statement.predicate.logs_hash
    });
    return {
      evidenceHash: toBytes32(deliveryStatementDigest(statement)),
      change: "customer cus_4c98be reclassified standard -> premium"
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The one field of the deal this module cares about. */
type DealView = { evidenceHash: string };

/**
 * Read the committed hash back off the chain and check it against the files.
 *
 * Everything else in this module proves the producer is self-consistent, which
 * is not the claim that matters. The claim is that the 32 bytes sitting in the
 * deal commit to the bytes on disk, and nothing establishes that without going
 * to the chain for one side of the comparison and to the filesystem for the
 * other.
 *
 * A review on 2026-08-30 showed why this is not optional. The regression guard
 * at the time read example source text looking for the literal that used to be
 * hashed. Putting that exact literal back, inlined so the identifier it matched
 * on disappeared, left all 22 tests green and the example still printing
 * SUCCESS: the deal carried a constant and every check in the repo agreed. A
 * source-text guard cannot see what was sent. This can.
 *
 * The recomputation is deliberately fresh rather than the caller's `delivery`,
 * so a caller that submitted something other than what it hashed is caught too.
 */
export async function assertCommittedOnChain(
  escrow: { getDeal(dealId: bigint): Promise<DealView> },
  dealId: bigint,
  label = "deal"
): Promise<string> {
  const onChain = (await escrow.getDeal(dealId)).evidenceHash;
  const fromFiles = exampleDelivery().evidenceHash;
  if (onChain !== fromFiles) {
    throw new Error(
      `${label} ${dealId} committed ${onChain}, but hashing examples/delivery/ ` +
        `gives ${fromFiles}. The on-chain value does not commit to the delivered ` +
        "bytes, so recomputing it in a dispute proves nothing either way."
    );
  }
  return onChain;
}
