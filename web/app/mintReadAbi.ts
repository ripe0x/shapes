import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { DENOMINATIONS } from "shapes-render/denominations";

const mintReadAbi = parseAbi([
  "function unit() view returns (uint256)",
  "function mintFee() view returns (uint256)",
  "function mintFeeFor(uint256 amountWei) view returns (uint256)",
  "function mintStart() view returns (uint256)",
]);

export interface MintReadCalls {
  unit: Hex;
  fee: Hex;
  start: Hex;
  legacyFees: Hex[];
}

/** These fixed read-only calls can be encoded on the server; the early form needs no browser
 * ABI encoder/decoder. Keep the declarations here authoritative for both denomination ladders. */
export function mintReadCalls(): MintReadCalls {
  return {
    unit: encodeFunctionData({ abi: mintReadAbi, functionName: "unit" }),
    fee: encodeFunctionData({ abi: mintReadAbi, functionName: "mintFee" }),
    start: encodeFunctionData({ abi: mintReadAbi, functionName: "mintStart" }),
    legacyFees: DENOMINATIONS.map((amount) => encodeFunctionData({
      abi: mintReadAbi, functionName: "mintFeeFor", args: [amount],
    })),
  };
}
