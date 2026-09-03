import type {Abi, Address, Hash, PublicClient} from "viem";

/**
 * Gas headroom applied to every write's estimate before it reaches the wallet. Shapes'
 * reentrancy guard re-executes under the 63/64 rule (EIP-150): a call sent at exactly the
 * estimate can run out of gas partway through that re-execution, most visibly on `mintBatch`.
 * Half again over the estimate, the same margin the site's auction bids already use.
 */
export function bufferGas(estimate: bigint): bigint {
  return (estimate * 3n) / 2n;
}

export interface ReplayCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/**
 * Waits for a transaction's receipt and throws when it reverted. `waitForTransactionReceipt`
 * alone does not distinguish a reverted-but-mined transaction from a successful one: both return
 * a receipt, so a caller that only awaits it reports a reverted write as done. Replays the same
 * call one block before it landed to recover a decodable reason (the contract's named error),
 * which `describeTxError` reads off the thrown error's cause chain.
 */
export async function awaitSuccessfulReceipt(publicClient: PublicClient, hash: Hash, call: ReplayCall) {
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status === "success") return receipt;
  const tx = await publicClient.getTransaction({hash});
  await publicClient.simulateContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    value: call.value,
    account: tx.from,
    blockNumber: receipt.blockNumber - 1n,
  } as Parameters<typeof publicClient.simulateContract>[0]);
  // The replay above is expected to throw with the decoded revert reason. If the same call now
  // succeeds instead (state moved between the two reads), report the plain fact.
  throw new Error("Transaction reverted");
}
