import {shapesAbi, type Deployment} from "../chain/abi";

/**
 * The contract write a mint issues: `mint(amountWei)` for one, `mintBatch(amountWei, quantity)` for
 * more, with `value` = (denomination + per-token fee) x quantity, pinned to the deployment chain.
 * Shared by SiteApp's mint handler and its transaction-initiation test so both send the same call.
 */
export function mintRequest(
  dep: Deployment,
  params: {amountWei: bigint; quantity: number; fee: bigint},
) {
  const {amountWei, quantity, fee} = params;
  const value = (amountWei + fee) * BigInt(quantity);
  const single = quantity === 1;
  return {
    address: dep.shapes,
    abi: shapesAbi,
    functionName: single ? "mint" : "mintBatch",
    args: single ? [amountWei] : [amountWei, BigInt(quantity)],
    value,
    chainId: dep.chainId,
  } as const;
}
