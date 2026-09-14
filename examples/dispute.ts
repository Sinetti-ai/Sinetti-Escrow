import { ethers, networkName } from "./_hardhat";

import {
  assertCommittedOnChain,
  describeDelivery,
  exampleDelivery,
  tamperedDelivery
} from "./_evidence";
import {
  assertEqual,
  exampleCriteria,
  fundAndOpen,
  postBond,
  resolveContext,
  send
} from "./_local";
import { attachedWindows, walletFromEnv } from "./_network";

const STATE_REFUNDED = 6n;
const OUTCOME_REFUND = 2n;
const MIN_PUSH_BUFFER_SECONDS = 3600n; // ConsoleArbitrator.MIN_PUSH_BUFFER
// On a public network the challenge and the proposal land in different blocks,
// so the ruling window must cover the wall-clock gap between them as well.
const PROPOSE_SLACK_SECONDS = 3600n;

async function main(): Promise<void> {
  const context = await resolveContext();
  const { amount, bond, challengerBond } = context.dealAmounts;

  // ConsoleArbitrator requires the deal's rulingWindow to clear its own
  // overrideWindow plus a 1-hour push buffer, or the escrow's timeout can
  // fire before push() lands, and propose() measures that from its own block,
  // not from the challenge. Read overrideWindow() up front and add slack so
  // the deal we open in attached mode actually admits a ruling.
  let overrideWindowSeconds = 0n;
  if (context.attached) {
    overrideWindowSeconds = await (context.arbitrator as { overrideWindow(): Promise<bigint> }).overrideWindow();
  }
  const windows = context.attached
    ? await attachedWindows(
        context.escrow,
        { challengeWindow: 3600n, rulingWindow: 86400n },
        overrideWindowSeconds + MIN_PUSH_BUFFER_SECONDS + PROPOSE_SLACK_SECONDS
      )
    : undefined;

  const criteria = exampleCriteria();
  const delivery = exampleDelivery();
  console.log("Seller hashes the delivery in examples/delivery/");
  console.log(describeDelivery(delivery));

  const buyerBalanceBefore = await context.token.balanceOf(context.buyerAddress);
  const escrowBalanceBefore = await context.token.balanceOf(context.escrowAddress);

  const dealId = await fundAndOpen(context, criteria, 3600n, windows);
  await postBond(context, dealId);
  await send(
    context,
    "Seller submits delivery evidence",
    context.escrow.connect(context.seller).submitDelivery(
      dealId,
      delivery.evidenceHash
    )
  );
  console.log(
    `  read back from chain: ${await assertCommittedOnChain(context.escrow, dealId)}`
  );
  await send(
    context,
    "Verifier records Pass; buyer challenge window opens",
    context.escrow.connect(context.verifier).recordVerification(dealId, 1)
  );
  // Why the buyer challenges. The contract stored the seller's 32 bytes and will
  // never look at them again, so this comparison happens entirely off chain,
  // between whoever holds the files. It is only worth running because the stored
  // value commits to the delivered bytes: recomputing it over the copy the buyer
  // actually received either reproduces the on-chain value or does not.
  const received = tamperedDelivery(delivery);
  console.log("\nBuyer recomputes the digest over the copy it received");
  console.log(`  committed on chain: ${delivery.evidenceHash}`);
  console.log(`  buyer's copy:       ${received.evidenceHash}`);
  console.log(`  difference:         ${received.change}`);
  if (received.evidenceHash === delivery.evidenceHash) {
    throw new Error(
      "an edited artifact produced the committed digest, so the evidence hash " +
        "distinguishes nothing and this example is showing a check that cannot fail"
    );
  }

  if (!context.attached) {
    await send(
      context,
      "Mint challenger-bond tokens to buyer",
      (context.token as import("../typechain-types").TestEUR).mint(context.buyerAddress, challengerBond)
    );
  }
  await send(
    context,
    "Buyer approves challenger bond",
    context.token.connect(context.buyer).approve(context.escrowAddress, challengerBond)
  );
  await send(
    context,
    "Buyer challenges the Pass, posting the challenger bond",
    context.escrow.connect(context.buyer).challenge(dealId)
  );

  if (!context.attached) {
    await send(
      context,
      "Arbitrator contract rules Refund; loser pays - seller bond slashed, challenger bond returned inside buyer credit",
      (context.arbitrator as import("../typechain-types").MockManualArbitrator).rule(
        context.escrowAddress,
        dealId,
        OUTCOME_REFUND
      )
    );
  } else {
    // ConsoleArbitrator's real flow: the agent proposes, the officer reviews.
    // The officer either overturns inside overrideWindow, rules outright with
    // rule() (lands on the escrow immediately), or stays silent, in which case
    // anyone pushes the standing outcome after the window. This receipt takes
    // the reviewed path: propose, then the officer confirms the same outcome.
    const arbitrator = context.arbitrator as import("../typechain-types").ConsoleArbitrator;
    const agent = walletFromEnv("ARBITRATOR_AGENT_PRIVATE_KEY");
    const officer = walletFromEnv("ARBITRATOR_OFFICER_PRIVATE_KEY");
    await send(
      context,
      "Arbitrator agent proposes Refund",
      arbitrator.connect(agent).propose(dealId, OUTCOME_REFUND)
    );
    await send(
      context,
      "Officer reviews and rules Refund; the ruling lands on the escrow now",
      arbitrator.connect(officer).rule(dealId, OUTCOME_REFUND)
    );
  }

  await send(
    context,
    "Buyer withdraws principal, slashed bond, and returned challenger bond",
    context.escrow.connect(context.buyer)["withdraw(address)"](context.tokenAddress)
  );

  const deal = await context.escrow.getDeal(dealId);
  const buyerBalanceAfter = await context.token.balanceOf(context.buyerAddress);
  const escrowBalanceAfter = await context.token.balanceOf(context.escrowAddress);
  // Local mode mints amount then challengerBond fresh after the "before" snapshot,
  // so the buyer's delta includes both plus the slashed seller bond. Attached
  // mode's buyer already held amount + challengerBond pre-funded before the
  // snapshot, so only the slashed seller bond is new.
  const expectedBuyerDelta = context.attached ? bond : amount + bond + challengerBond;
  assertEqual(deal.state, STATE_REFUNDED, "deal state");
  assertEqual(buyerBalanceAfter - buyerBalanceBefore, expectedBuyerDelta, "buyer refund");
  assertEqual(escrowBalanceAfter - escrowBalanceBefore, 0n, "escrow balance change");
  console.log(`\nSUCCESS: deal #${dealId} refunded by arbitrator ruling after buyer challenge; seller bond slashed to buyer, challenger bond returned.`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
