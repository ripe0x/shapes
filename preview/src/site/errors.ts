import {BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatEther} from "viem";

/** Plain-language text per custom error the token can revert with. */
const ERROR_TEXT: Record<string, (args: readonly unknown[]) => string> = {
  UnsupportedDenomination: () => "That amount is not one of the nine denominations.",
  DenominationIndexOutOfRange: () => "That denomination does not exist. Pick one of the nine.",
  IncorrectPayment: (a) => `The payment must be exact: ${formatEther(a[0] as bigint)} ETH.`,
  ZeroQuantity: () => "Quantity must be at least 1.",
  MintNotOpen: () => "Minting has not opened yet.",
  NotShapeOwner: () => "Only the owner of this Shape can do that.",
  EthTransferFailed: () => "The ETH transfer failed. Nothing was burned.",
  InvalidRecipient: () => "The recipient cannot be the zero address.",
  DirectDepositRejected: () => "The contract does not accept direct ETH transfers.",
  SelfCustodyRejected: () => "A Shape cannot be sent to the Shapes contract.",
  TokenIsBlack: () => "A Black Shape cannot be used here.",
  NoComposeInputs: () => "Select at least two Shapes.",
  CannotComposeWithSelf: () => "A Shape cannot be composed with itself.",
  DuplicateComposeInput: () => "The same Shape is selected twice.",
  SplitSumMismatch: () => "The outputs must sum to exactly the input's backing.",
  SplitTooFewOutputs: () => "A split must produce at least two Shapes.",
  NoComposeRecord: () => "This Shape has no compose left to undo.",
  NotApexComplete: () => "Only a complete apex Shape can have its backing burned into Black.",
  NotASplitChild: () => "This Shape was not created by a split.",
  ComposeRecordOutOfRange: () => "This Shape has no compose at that depth.",
  NoOwnerToken: () => "The collection has no owner token: it was redeemed or burned.",
  PresentationIsLocked: () => "Presentation is permanently locked and cannot be changed.",
  UnsupportedRenderer: () => "That address is not a Shapes renderer.",
  UnsupportedCollection: () => "That address is not a Shapes collection contract.",
  InvalidCopy: (a) => (a[0] === 0 ? "That name is not valid metadata copy." : "That description is not valid metadata copy."),
  InvalidPointer: () => "That pointer does not exist.",
  InvalidPointerTarget: () => "That address does not support the interface the pointer needs.",
  PointerIsLocked: () => "That pointer is permanently locked and cannot be changed.",
  ArtistAlreadyAttested: () => "The artist has already attested.",
  InvalidArtistReleaseHash: () => "The release hash cannot be empty.",
  InvalidArtistSignature: () => "The artist signature does not match.",
  MintFeeAboveCap: () => "The mint fee is above its cap.",
  NoFeesPending: () => "There are no fees to withdraw.",
  AdminUnauthorizedAccount: () => "Only the admin can do that.",
  AdminInvalidAdmin: () => "The new admin cannot be the zero address.",
  AdminInvalidFeeRecipient: () => "The fee recipient cannot be the zero address.",
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
