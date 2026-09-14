import { readFileSync } from "node:fs";

import { Contract, JsonRpcProvider, Wallet } from "ethers";

import { ESCROW_ABI } from "../src/dealClient";
import { CONSOLE_ARBITRATOR_ABI } from "../src/dealLifecycle";
import {
  overturnRuling,
  proposeRuling,
  pushRuling,
  outcomeFromName
} from "../src/dealLifecycle";
import {
  arbitrationCaseHash,
  assertCaseMatchesDeal,
  assertCaseMatchesProposal,
  prepareOfficerOverturn,
  type ArbitrationCase
} from "../src/arbitrator";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const casePath = process.argv[3];
  if (!action || !casePath) {
    throw new Error(
      "Usage: npm run arbitrator -- <propose|officer-calldata|overturn|push> <case.json>"
    );
  }
  const caseFile = JSON.parse(readFileSync(casePath, "utf8")) as ArbitrationCase;
  if (action === "officer-calldata") {
    console.log(JSON.stringify(prepareOfficerOverturn(caseFile), null, 2));
    return;
  }

  const provider = new JsonRpcProvider(required("ARBITRATOR_RPC_URL"));
  const network = await provider.getNetwork();
  const escrow = new Contract(caseFile.escrow, ESCROW_ABI, provider);
  const deal = await escrow.getDeal(caseFile.deal_id);
  assertCaseMatchesDeal(caseFile, deal, network.chainId);
  if (action === "push") {
    const arbitrator = new Contract(caseFile.arbitrator, CONSOLE_ARBITRATOR_ABI, provider);
    const [proposal, overrideWindow, latest] = await Promise.all([
      arbitrator.proposals(caseFile.deal_id),
      arbitrator.overrideWindow(),
      provider.getBlock("latest")
    ]);
    if (!latest) throw new Error("cannot read the selected network's latest block");
    assertCaseMatchesProposal(caseFile, proposal, BigInt(latest.timestamp), overrideWindow);
  }

  const keyName = action === "overturn"
    ? "ARBITRATOR_OFFICER_PRIVATE_KEY"
    : action === "push"
      ? "ARBITRATOR_RELAYER_PRIVATE_KEY"
      : "ARBITRATOR_PRIVATE_KEY";
  const signer = new Wallet(required(keyName), provider);
  const common = {
    escrowAddress: caseFile.escrow,
    arbitratorAddress: caseFile.arbitrator,
    signer,
    dealId: caseFile.deal_id
  };
  const receipt =
    action === "propose"
      ? await proposeRuling({
          ...common,
          outcome: outcomeFromName(caseFile.proposed_outcome)
        })
      : action === "overturn"
        ? await overturnRuling({
            ...common,
            outcome: outcomeFromName(caseFile.proposed_outcome)
          })
        : action === "push"
          ? await pushRuling(common)
          : (() => {
              throw new Error(`unknown action ${action}`);
            })();

  console.log(
    JSON.stringify(
      { action, caseHash: arbitrationCaseHash(caseFile), receipt },
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
