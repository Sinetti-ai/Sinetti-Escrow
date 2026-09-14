import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";

import {
  assertCommittedOnChain,
  exampleDelivery,
  tamperedDelivery
} from "../examples/_evidence";
import { openDealWithSellerAcceptanceV04 } from "./helpers/sellerAcceptanceV04";
import { deliveryStatementDigest } from "../src/evidenceManifest";
import {
  buildFromOptions,
  parseArgs,
  writeStatement,
  type EvidenceHashOptions
} from "../scripts/evidence-hash";

const EXAMPLES = join(import.meta.dirname, "..", "examples");
const DELIVERY = join(EXAMPLES, "delivery");

function requiredArgs(deliverable: string): string[] {
  return [
    "--deliverable", deliverable,
    "--repo-commit", "9f2c1b7a4e6d80f3c5a1b9e7d2f4a6c8e0b3d5f7",
    "--runtime-hash", "b".repeat(64),
    "--logs-hash", "c".repeat(64)
  ];
}

describe("evidence-hash script", function () {
  let temp: string;
  let outDir: string;

  beforeEach(function () {
    temp = mkdtempSync(join(tmpdir(), "evidence-hash-"));
    // A separate directory, because --out now refuses to write inside the
    // delivery, and because the first version of these tests wrote to a fixed
    // path in the shared temp root that two concurrent runs would collide on.
    outDir = mkdtempSync(join(tmpdir(), "evidence-hash-out-"));
  });

  afterEach(function () {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  describe("parseArgs refuses to guess", function () {
    it("accepts a fully specified invocation", function () {
      const options = parseArgs(requiredArgs("./out"));
      expect(options.deliverable).to.equal("./out");
      expect(options.repoCommit).to.equal("9f2c1b7a4e6d80f3c5a1b9e7d2f4a6c8e0b3d5f7");
      expect(options.runtimeHash).to.equal("b".repeat(64));
      expect(options.logsHash).to.equal("c".repeat(64));
      expect(options.out).to.equal(undefined);
      expect(options.force).to.equal(false);
    });

    // A typo must not be dropped. If --runtime-hsh were ignored, the failure
    // surfaces as "--runtime or --runtime-hash is required", pointing the
    // caller at an argument they believe they passed.
    it("rejects an unknown option rather than ignoring it", function () {
      expect(() => parseArgs([...requiredArgs("./out"), "--runtime-hsh", "x"])).to.throw(
        /unknown option --runtime-hsh/
      );
    });

    for (const missing of ["--deliverable", "--repo-commit", "--runtime-hash", "--logs-hash"]) {
      it(`rejects an invocation with no ${missing}`, function () {
        const args = requiredArgs("./out");
        const at = args.indexOf(missing);
        args.splice(at, 2);
        expect(() => parseArgs(args)).to.throw();
      });
    }

    it("rejects a digest that is not 64 lowercase hex characters", function () {
      const args = requiredArgs("./out");
      args[args.indexOf("--runtime-hash") + 1] = "B".repeat(64);
      expect(() => parseArgs(args)).to.throw(/64 lowercase hex/);
    });

    it("rejects a path and a digest for the same input", function () {
      expect(() => parseArgs([...requiredArgs("./out"), "--logs", "./run.log"])).to.throw(
        /alternatives; pass exactly one/
      );
    });

    it("rejects a repeated option instead of silently taking one", function () {
      expect(() => parseArgs([...requiredArgs("./out"), "--deliverable", "./other"])).to.throw(
        /--deliverable given twice/
      );
    });

    it("rejects an option whose value is the next flag", function () {
      expect(() => parseArgs(["--deliverable", "--repo-commit", "abc"])).to.throw(
        /--deliverable needs a value/
      );
    });

    // An unset shell variable expands to "". Before this guard, --out "$OUT"
    // with OUT unset meant no statement was written, no warning was printed,
    // and the process exited 0.
    for (const flag of ["--deliverable", "--repo-commit", "--runtime-hash", "--logs-hash", "--out"]) {
      it(`rejects an empty value for ${flag}`, function () {
        const args = requiredArgs("./out");
        const at = args.indexOf(flag);
        if (at === -1) args.push(flag, "");
        else args[at + 1] = "";
        expect(() => parseArgs(args)).to.throw(/empty value/);
      });
    }

    // Whitespace is invisible in render() output and changes the digest, so a
    // pasted commit id with a trailing space becomes an unexplained
    // verifier-spec check 3 mismatch weeks later.
    it("rejects a value with trailing whitespace rather than trimming it", function () {
      const args = requiredArgs("./out");
      args[args.indexOf("--repo-commit") + 1] = "9f2c1b7a ";
      expect(() => parseArgs(args)).to.throw(/leading or trailing whitespace/);
    });

    it("takes --force as a flag with no value", function () {
      expect(parseArgs([...requiredArgs("./out"), "--force"]).force).to.equal(true);
      expect(() => parseArgs([...requiredArgs("./out"), "--force", "--force"])).to.throw(
        /--force given twice/
      );
    });
  });

  // Every option must reach the predicate field it names. A swap here, or a
  // discarded value, produces a perfectly well-formed digest over the wrong
  // facts, and nothing downstream can tell.
  describe("each input lands in the field it names", function () {
    it("carries repo-commit, runtime and logs into the predicate unchanged", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const built = buildFromOptions(parseArgs(requiredArgs(temp)));
      expect(built.statement.predicate).to.deep.equal({
        repo_commit_hash: "9f2c1b7a4e6d80f3c5a1b9e7d2f4a6c8e0b3d5f7",
        runtime_hash: "b".repeat(64),
        logs_hash: "c".repeat(64)
      });
    });

    it("changes the digest when only the predicate changes", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const base = buildFromOptions(parseArgs(requiredArgs(temp))).digestHex;
      const args = requiredArgs(temp);
      args[args.indexOf("--repo-commit") + 1] = "0".repeat(40);
      expect(buildFromOptions(parseArgs(args)).digestHex).to.not.equal(base);
    });
  });

  describe("--out cannot damage the delivery", function () {
    it("refuses to write into the delivery directory", function () {
      expect(() =>
        parseArgs([...requiredArgs(temp), "--out", join(temp, "statement.json")])
      ).to.throw(/inside the delivery/);
    });

    it("refuses to write over a delivered file", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      expect(() =>
        parseArgs([...requiredArgs(temp), "--out", join(temp, "report.md")])
      ).to.throw(/inside the delivery/);
    });

    it("refuses to replace an existing file unless forced", function () {
      const out = join(outDir, "statement.json");
      writeFileSync(out, "prior");
      expect(() => parseArgs([...requiredArgs(temp), "--out", out])).to.throw(/already exists/);
      expect(parseArgs([...requiredArgs(temp), "--out", out, "--force"]).out).to.equal(out);
    });

    it("accepts an --out beside the delivery", function () {
      expect(parseArgs([...requiredArgs(temp), "--out", join(outDir, "s.json")]).out).to.be.a(
        "string"
      );
    });
  });

  describe("the digest tracks the delivered bytes", function () {
    function digestOf(deliverable: string): string {
      return buildFromOptions(parseArgs(requiredArgs(deliverable)) as EvidenceHashOptions).digestHex;
    }

    it("changes when one byte of one delivered file changes", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const before = digestOf(temp);
      writeFileSync(join(temp, "report.md"), "row count: 4\n");
      expect(digestOf(temp)).to.not.equal(before);
    });

    it("changes when a file is added to the delivery", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const before = digestOf(temp);
      writeFileSync(join(temp, "extra.md"), "");
      expect(digestOf(temp)).to.not.equal(before);
    });

    it("is stable across runs over unchanged bytes", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      expect(digestOf(temp)).to.equal(digestOf(temp));
    });
  });

  // The one promise in docs/evidence.md that no other test covers: a third
  // party with sha256sum and nothing else reproduces the on-chain value. A
  // trailing newline or a pretty-print breaks it while leaving a file that still
  // parses and still looks correct.
  describe("the written statement is independently checkable", function () {
    it("hashes, as raw file bytes, to the value that goes on chain", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const built = buildFromOptions(parseArgs(requiredArgs(temp)));
      const out = join(outDir, "statement.json");
      writeStatement(out, built.statement);
      expect(createHash("sha256").update(readFileSync(out)).digest("hex")).to.equal(
        built.digestHex
      );
    });

    it("round-trips through JSON.parse to the same statement", function () {
      writeFileSync(join(temp, "report.md"), "row count: 3\n");
      const built = buildFromOptions(parseArgs(requiredArgs(temp)));
      const out = join(outDir, "statement-roundtrip.json");
      writeStatement(out, built.statement);
      expect(deliveryStatementDigest(JSON.parse(readFileSync(out, "utf8")))).to.equal(
        built.digestHex
      );
    });
  });

  describe("the examples commit to the fixture they ship", function () {
    it("names every file under examples/delivery and nothing else", function () {
      const onDisk = readdirSync(DELIVERY).sort();
      expect(onDisk, "examples/delivery is empty").to.have.length.greaterThan(0);
      expect(exampleDelivery().statement.subject.map((s) => s.name)).to.deep.equal(onDisk);
    });

    it("digests each file to its actual contents", function () {
      for (const subject of exampleDelivery().statement.subject) {
        const bytes = readFileSync(join(DELIVERY, subject.name));
        expect(subject.digest.sha256, subject.name).to.equal(
          createHash("sha256").update(bytes).digest("hex")
        );
      }
    });

    it("produces a different hash for an edited artifact", function () {
      const delivery = exampleDelivery();
      expect(tamperedDelivery(delivery).evidenceHash).to.not.equal(delivery.evidenceHash);
    });
  });

  // The check that actually constrains the examples: go to the chain for one
  // side of the comparison and to the filesystem for the other. Everything else
  // in this file proves the producer is self-consistent, which is not the claim.
  //
  // This block exists because the source-text guard below was not enough. On
  // 2026-08-30 a review put the original defect back into dispute.ts, inlined so
  // the identifier the regex matched on disappeared, and got 22 passing tests
  // plus an example printing SUCCESS over a deal carrying a constant.
  describe("the value in the deal commits to the delivered bytes", function () {
    const AMOUNT = 100_000n;
    const BOND = 25_000n;
    const CHALLENGER_BOND = 10_000n;
    const DURATION = 7_200n;
    const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");

    async function fundedDeal() {
      const [owner, buyer, seller, verifier] = await ethers.getSigners();
      const tokenFactory = await ethers.getContractFactory("MockUSDC");
      const token = (await tokenFactory.connect(owner).deploy()) as Contract;
      await token.waitForDeployment();
      // Only needs to be a contract; openDeal rejects an arbitrator without code.
      const arbitrator = (await tokenFactory.connect(owner).deploy()) as Contract;
      await arbitrator.waitForDeployment();

      const escrowFactory = await ethers.getContractFactory("SinettiEscrowV04");
      const escrow = (await escrowFactory.connect(owner).deploy(
        await owner.getAddress(),
        [
          {
            token: await token.getAddress(),
            maxAmount: ethers.MaxUint256,
            maxBond: ethers.MaxUint256,
            minBondBps: 0,
            minChallengerBondBps: 0
          }
        ],
        [],
        [],
        60,
        60
      )) as Contract;
      await escrow.waitForDeployment();

      await token.mint(await buyer.getAddress(), AMOUNT * 10n);
      await token.connect(buyer).approve(await escrow.getAddress(), AMOUNT * 10n);
      await token.mint(await seller.getAddress(), BOND * 10n);
      await token.connect(seller).approve(await escrow.getAddress(), BOND * 10n);

      const transaction = await openDealWithSellerAcceptanceV04(
        escrow,
        buyer,
        seller,
        await seller.getAddress(),
        await verifier.getAddress(),
        await arbitrator.getAddress(),
        token,
        AMOUNT,
        BOND,
        CHALLENGER_BOND,
        TERMS_HASH,
        DURATION
      );
      const receipt = await transaction.wait();
      if (!receipt) throw new Error("openDeal was not mined");
      const opened = receipt.logs
        .map((entry: { topics: string[]; data: string }) => {
          try {
            return escrow.interface.parseLog(entry);
          } catch {
            return null;
          }
        })
        .find((parsed: { name: string } | null) => parsed?.name === "DealOpened");
      if (!opened) throw new Error("DealOpened not emitted");
      const dealId = opened.args.dealId as bigint;
      await escrow.connect(seller).postBond(dealId);
      return { escrow, seller, dealId };
    }

    it("stores and emits exactly the digest of examples/delivery", async function () {
      const { escrow, seller, dealId } = await fundedDeal();
      const expected = exampleDelivery().evidenceHash;
      await expect(escrow.connect(seller).submitDelivery(dealId, expected))
        .to.emit(escrow, "DeliverySubmitted")
        .withArgs(dealId, expected);
      expect((await escrow.getDeal(dealId)).evidenceHash).to.equal(expected);
      expect(await assertCommittedOnChain(escrow as never, dealId)).to.equal(expected);
    });

    // The anchor. Without it the check above passes for any deal at all, and a
    // helper that returned early or compared a value to itself would look green.
    it("rejects a deal carrying anything else, including the old constant", async function () {
      const { escrow, seller, dealId } = await fundedDeal();
      const constant = createHash("sha256")
        .update(
          JSON.stringify({
            artifact: "customer-export.json",
            content: "representative customer export"
          })
        )
        .digest("hex");
      await escrow.connect(seller).submitDelivery(dealId, `0x${constant}`);
      let threw = "";
      try {
        await assertCommittedOnChain(escrow as never, dealId);
      } catch (error) {
        threw = (error as Error).message;
      }
      expect(threw, "a deal carrying the old constant was accepted").to.match(
        /does not commit to the delivered bytes/
      );
    });

    it("rejects a deal whose digest was taken over edited bytes", async function () {
      const { escrow, seller, dealId } = await fundedDeal();
      await escrow
        .connect(seller)
        .submitDelivery(dealId, tamperedDelivery(exampleDelivery()).evidenceHash);
      let threw = "";
      try {
        await assertCommittedOnChain(escrow as never, dealId);
      } catch (error) {
        threw = (error as Error).message;
      }
      expect(threw).to.match(/does not commit to the delivered bytes/);
    });
  });

  // A cheap second line, running in the unit suite where the on-chain check
  // above already runs, and in CI where the examples themselves run. It catches
  // an example dropping the shared delivery outright. It does NOT catch a
  // respelled constant, which is what the on-chain block is for.
  describe("every example still routes through the shared delivery", function () {
    const entries = ["full-lifecycle", "dispute"];

    function sourceOf(entry: string): string {
      return readFileSync(join(EXAMPLES, `${entry}.ts`), "utf8");
    }

    // Anchor. Without it, a renamed or unreadable example makes every assertion
    // below pass over an empty string.
    it("reads example sources that actually submit a delivery", function () {
      for (const entry of entries) {
        const source = sourceOf(entry);
        expect(source, `${entry}.ts read as empty`).to.have.length.greaterThan(500);
        expect(source, `${entry}.ts does not submit delivery`).to.contain("submitDelivery");
      }
    });

    for (const entry of entries) {
      it(`${entry}.ts submits delivery.evidenceHash at the call site`, function () {
        const source = sourceOf(entry);
        expect(source).to.contain("exampleDelivery()");
        // Anchored on the call site rather than on the identifier anywhere in
        // the file: dispute.ts mentions delivery.evidenceHash three times, so a
        // bare `contain` there passes even after the submitted value is swapped.
        expect(source).to.match(/submitDelivery\(\s*\n?\s*dealId,\s*\n?\s*delivery\.evidenceHash/);
        expect(source).to.contain("assertCommittedOnChain(");
      });
    }
  });
});
