import {BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatEther} from "viem";

/** Plain-language text per IShapes custom error. */
const ERROR_TEXT: Record<string, (args: readonly unknown[]) => string> = {
  UnsupportedDenomination: () => "That amount is not one of the nine denominations.",
  IncorrectPayment: (a) => `The payment must be exact: ${formatEther(a[0] as bigint)} ETH.`,
  ZeroQuantity: () => "Quantity must be at least 1.",
  NotShapeOwner: () => "Only the owner of this Shape can do that.",
  EthTransferFailed: () => "The ETH transfer failed. Nothing was burned.",
  MintFeeTransferFailed: () => "The fee transfer failed. Nothing was minted.",
  DirectDepositRejected: () => "The contract does not accept direct ETH transfers.",
  SelfCustodyRejected: () => "A Shape cannot be sent to the Shapes contract.",
  RendererIsLocked: () => "The renderer is locked.",
  TokenIsBlack: () => "A Black Shape cannot be used here.",
  EmptyRecomposition: () => "Select at least two Shapes.",
  CannotComposeWithSelf: () => "A Shape cannot be composed with itself.",
  SplitMismatch: () => "The outputs must sum to exactly the input's backing.",
  NoComposeRecord: () => "This Shape has no compose left to undo.",
  NotApexComplete: () => "Only a complete 100 ETH Shape can be sacrificed into Black.",
};

/**
 * One plain sentence for a failed transaction. Custom errors decode by name; a wallet
 * rejection gets its own line; anything else falls back to viem's shortMessage, which lives
 * at varying depths of the cause chain.
 */
export function describeTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const rejected = e.walk((err) => err instanceof UserRejectedRequestError);
    if (rejected) return "The transaction was rejected in the wallet.";
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name && ERROR_TEXT[name]) return ERROR_TEXT[name](reverted.data?.args ?? []);
      if (name) return `The transaction reverted: ${name}.`;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
