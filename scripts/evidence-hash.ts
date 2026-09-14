/**
 * Produce the value `submitDelivery` takes, from the bytes actually delivered.
 *
 * A 32-byte value can be syntactically valid while committing to nothing. This
 * command derives it from the delivered files so the value can be reproduced
 * and checked later.
 *
 * This is that caller. It walks the delivered files, builds the in-toto
 * Statement v1 that `schemas/evidence-envelope.schema.json` defines, and prints
 * the digest in both the forms that matter: bare hex for the envelope's
 * `artifact_hash`, and `0x`-prefixed for the chain. `docs/evidence.md`
 * check 1 requires those to be the same 32 bytes.
 *
 * Every input is required. None of them defaults, and that is the whole design:
 * a placeholder `repo_commit_hash` or a zero `runtime_hash` would produce a
 * digest that looks exactly as legitimate as a real one, and no later check
 * could tell them apart.
 *
 *   npm run evidence:hash -- \
 *     --deliverable ./out \
 *     --repo-commit "$(git rev-parse HEAD)" \
 *     --runtime package-lock.json \
 *     --logs ./out/test.log \
 *     --out evidence-statement.json
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  buildDeliveryStatement,
  buildSubject,
  canonicalJson,
  deliveryStatementDigest,
  hashFile,
  toBytes32,
  type DeliveryStatement
} from "../src/evidenceManifest";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type EvidenceHashOptions = {
  deliverable: string;
  repoCommit: string;
  runtimeHash: string;
  logsHash: string;
  out?: string;
  force: boolean;
};

const USAGE = `Usage: npm run evidence:hash -- --deliverable <path> --repo-commit <id> \\
    (--runtime <path> | --runtime-hash <sha256>) (--logs <path> | --logs-hash <sha256>) \\
    [--out <file>] [--force]

  --deliverable   File or directory of the delivered artifact. Every file under a
                  directory is hashed individually; an archive is never hashed.
  --repo-commit   The exact revision under test (verifier-spec check 3).
  --runtime       File whose SHA-256 fingerprints the agreed execution environment
                  (a lockfile, an image manifest).
  --runtime-hash  That fingerprint directly, as 64 lowercase hex characters.
  --logs          The test log file; its SHA-256 becomes logs_hash.
  --logs-hash     That digest directly, as 64 lowercase hex characters.
  --out           Write the canonical statement here; sha256sum over it
                  reproduces artifact_hash. Must be outside --deliverable.
  --force         Allow --out to replace an existing file.`;

function digestOption(
  name: string,
  fromPath: string | undefined,
  fromHex: string | undefined
): string {
  if (fromPath !== undefined && fromHex !== undefined) {
    throw new Error(`--${name} and --${name}-hash are alternatives; pass exactly one`);
  }
  if (fromPath !== undefined) return hashFile(fromPath);
  if (fromHex === undefined) throw new Error(`--${name} or --${name}-hash is required`);
  if (!SHA256_HEX.test(fromHex)) {
    throw new Error(`--${name}-hash must be 64 lowercase hex characters, not ${fromHex}`);
  }
  return fromHex;
}

const VALUE_OPTIONS = [
  "deliverable",
  "repo-commit",
  "runtime",
  "runtime-hash",
  "logs",
  "logs-hash",
  "out"
];

const FLAG_OPTIONS = ["force"];

export function parseArgs(argv: string[]): EvidenceHashOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    const key = flag.slice(2);

    if (FLAG_OPTIONS.includes(key)) {
      if (flags.has(key)) throw new Error(`--${key} given twice`);
      flags.add(key);
      continue;
    }
    if (!VALUE_OPTIONS.includes(key)) {
      // A misspelled flag must not be ignored. Silently dropping --runtime-hsh
      // leaves the required-input error pointing at the wrong thing, or worse,
      // is caught by nothing at all if the option ever gains a default.
      throw new Error(`unknown option --${key}`);
    }
    if (values.has(key)) throw new Error(`--${key} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} needs a value`);
    }
    // An unset shell variable expands to an empty string, so `--out "$OUT"`
    // with OUT unset used to mean "--out was not given" and the run silently
    // produced no statement. Every option here needs real content.
    if (value === "") throw new Error(`--${key} was given an empty value`);
    // Whitespace is invisible in this script's own output and changes the
    // digest. A trailing space on a pasted commit id turns into an unexplained
    // verifier-spec check 3 mismatch weeks later. Refuse rather than trim: a
    // tool that produces a commitment commits to what it was handed, exactly,
    // or it declines.
    if (value !== value.trim()) {
      throw new Error(`--${key} has leading or trailing whitespace: ${JSON.stringify(value)}`);
    }
    values.set(key, value);
    i += 1;
  }

  const deliverable = values.get("deliverable");
  if (!deliverable) throw new Error("--deliverable is required");
  const repoCommit = values.get("repo-commit");
  if (!repoCommit) throw new Error("--repo-commit is required");

  const options: EvidenceHashOptions = {
    deliverable,
    repoCommit,
    runtimeHash: digestOption("runtime", values.get("runtime"), values.get("runtime-hash")),
    logsHash: digestOption("logs", values.get("logs"), values.get("logs-hash")),
    out: values.get("out"),
    force: flags.has("force")
  };
  if (options.out !== undefined) assertOutIsSafe(options);
  return options;
}

/**
 * Refuse an `--out` that would damage the delivery or an existing file.
 *
 * Two ways the write goes wrong, both observed against the first version of this
 * script and both exiting 0:
 *
 *  - `--out` naming a delivered file replaced that file with the statement. The
 *    subject list still carried the file's original digest, so the commitment
 *    named bytes that no longer existed anywhere and the seller had destroyed
 *    the artifact they had just committed to.
 *  - `--out` anywhere else inside the delivery directory added a file the
 *    subject list does not name, which fails verifier-spec check 2 ("a file
 *    present in the delivery but absent from the subject list is not delivered
 *    evidence") and made the digest change on every rerun.
 *
 * Containment is checked against the resolved paths so `..` and symlinked
 * parents cannot walk back in.
 */
function assertOutIsSafe(options: EvidenceHashOptions): void {
  const out = path.resolve(options.out as string);
  const target = path.resolve(options.deliverable);
  const relative = path.relative(target, out);
  const inside =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (inside) {
    throw new Error(
      `--out ${options.out} is inside the delivery at ${options.deliverable}. ` +
        "Writing the statement into the delivery either destroys a delivered " +
        "file or adds one the subject list does not name. Write it elsewhere."
    );
  }
  if (existsSync(out) && !options.force) {
    throw new Error(
      `--out ${options.out} already exists. Pass --force to replace it; the ` +
        "statement is the only record of what the on-chain hash commits to, so " +
        "it is not overwritten by accident."
    );
  }
  if (existsSync(out) && statSync(out).isDirectory()) {
    throw new Error(`--out ${options.out} is a directory`);
  }
}

export function buildFromOptions(options: EvidenceHashOptions): {
  statement: DeliveryStatement;
  digestHex: string;
  evidenceHash: string;
} {
  const statement = buildDeliveryStatement({
    subject: buildSubject(options.deliverable),
    repoCommitHash: options.repoCommit,
    runtimeHash: options.runtimeHash,
    logsHash: options.logsHash
  });
  const digestHex = deliveryStatementDigest(statement);
  return { statement, digestHex, evidenceHash: toBytes32(digestHex) };
}

export function render(options: EvidenceHashOptions, built: ReturnType<typeof buildFromOptions>): string {
  const files = built.statement.subject
    .map((s) => `  ${s.digest.sha256}  ${s.name}`)
    .join("\n");
  return [
    `Delivery statement over ${options.deliverable}`,
    "",
    files,
    "",
    `  repo_commit_hash  ${built.statement.predicate.repo_commit_hash}`,
    `  runtime_hash      ${built.statement.predicate.runtime_hash}`,
    `  logs_hash         ${built.statement.predicate.logs_hash}`,
    "",
    `artifact_hash  ${built.digestHex}`,
    `EVIDENCE_HASH=${built.evidenceHash}`
  ].join("\n");
}

/**
 * Write the canonical statement, with no trailing newline.
 *
 * `docs/evidence.md` promises that `sha256sum` over these exact bytes
 * reproduces the on-chain value with no Sinetti tooling. A newline, a
 * pretty-print, or a wrapper object around the statement all break that promise
 * silently: the file still looks right and no longer hashes right. That is why
 * this is a named function with its own test rather than an inline call.
 *
 * The envelope's other fields are deliberately absent. evidence_id,
 * agreement_id, artifact_ref, logs_ref, submitted_by and submitted_at belong to
 * whoever submits, and the signature cannot be produced here at all;
 * placeholders would ship an envelope that validates and means nothing.
 */
export function writeStatement(out: string, statement: DeliveryStatement): void {
  writeFileSync(out, canonicalJson(statement));
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const built = buildFromOptions(options);
    if (options.out) {
      writeStatement(options.out, built.statement);
    }
    console.log(render(options, built));
    if (options.out) {
      console.log(
        `\nWrote the canonical statement to ${options.out}; \`sha256sum\` over it ` +
          "reproduces artifact_hash above. Set it as the envelope's `statement`, " +
          "then add evidence_id, agreement_id, artifact_ref, logs_ref, " +
          "submitted_by, submitted_at and the seller signature before it " +
          "validates against schemas/evidence-envelope.schema.json."
      );
    }
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
  }
}
