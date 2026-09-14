import { ethers, networkName } from "./_hardhat";

import { envAddress, walletFromEnv } from "./_network";

/**
 * Attached-mode only: the officer rules a live disputed deal on a deployed
 * ConsoleArbitrator with rule(), which lands on the escrow in the same
 * transaction, then the winning party withdraws. Use it when the agent's
 * proposal never landed or the officer has reviewed and wants to settle now.
 *
 *   SINETTI_DEAL_ID=6 SINETTI_OUTCOME=refund npx hardhat run examples/officer-rule.ts --network sepolia
 */

const OUTCOMES: Record<string, bigint> = { release: 1n, refund: 2n };
const STATE = { Disputed: 4n, Released: 5n, Refunded: 6n };

async function main(): Promise<void> {
  const escrowAddress = envAddress("SINETTI_ESCROW_ADDRESS");
  const arbitratorAddress = envAddress("SINETTI_ARBITRATOR_ADDRESS");
  const tokenAddress = envAddress("SINETTI_TOKEN_ADDRESS");
  const dealIdRaw = process.env.SINETTI_DEAL_ID?.trim();
  if (!dealIdRaw || !/^\d+$/.test(dealIdRaw)) throw new Error("SINETTI_DEAL_ID must be a deal number.");
  const dealId = BigInt(dealIdRaw);
  const outcomeName = (process.env.SINETTI_OUTCOME ?? "").trim().toLowerCase();
  const outcome = OUTCOMES[outcomeName];
  if (outcome === undefined) throw new Error("SINETTI_OUTCOME must be release or refund.");

  const officer = walletFromEnv("ARBITRATOR_OFFICER_PRIVATE_KEY");
  const winner = walletFromEnv(outcome === OUTCOMES.refund ? "BUYER_PRIVATE_KEY" : "SELLER_PRIVATE_KEY");

  const escrow = await ethers.getContractAt("SinettiEscrowV04", escrowAddress);
  const arbitrator = await ethers.getContractAt("ConsoleArbitrator", arbitratorAddress);

  const before = await escrow.getDeal(dealId);
  if (before.state !== STATE.Disputed) throw new Error(`deal ${dealId} is in state ${before.state}, not Disputed.`);
  if (before.arbitrator.toLowerCase() !== arbitratorAddress.toLowerCase()) {
    throw new Error(`deal ${dealId} names arbitrator ${before.arbitrator}, not ${arbitratorAddress}.`);
  }
  if ((await arbitrator.officer()).toLowerCase() !== (await officer.getAddress()).toLowerCase()) {
    throw new Error("ARBITRATOR_OFFICER_PRIVATE_KEY is not the deployed officer.");
  }

  console.log(`Officer rules ${outcomeName} on deal ${dealId}`);
  const ruling = await arbitrator.connect(officer).rule(dealId, outcome);
  const rulingReceipt = await ruling.wait();
  console.log(`  tx: ${ruling.hash} (block ${rulingReceipt?.blockNumber})`);

  const after = await escrow.getDeal(dealId);
  const expected = outcome === OUTCOMES.refund ? STATE.Refunded : STATE.Released;
  if (after.state !== expected) throw new Error(`deal ${dealId} ended in state ${after.state}, expected ${expected}.`);
  console.log(`  deal ${dealId} state: ${outcome === OUTCOMES.refund ? "Refunded" : "Released"}`);

  const winnerLabel = outcome === OUTCOMES.refund ? "Buyer" : "Seller";
  console.log(`${winnerLabel} withdraws`);
  const withdrawal = await escrow.connect(winner)["withdraw(address)"](tokenAddress);
  const withdrawalReceipt = await withdrawal.wait();
  console.log(`  tx: ${withdrawal.hash} (block ${withdrawalReceipt?.blockNumber})`);

  console.log(`\nSUCCESS: deal #${dealId} settled by officer ruling (${outcomeName}); ${winnerLabel.toLowerCase()} withdrew.`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
