/**
 * Confirmation copy for a lifecycle action that touches collection ownership (see `ownerToken()`
 * and issue #56). Pure and UI-free: `ManageShapeView` and `ComposeWorkspace` render the returned
 * notices as an explicit line in their confirmation step, not a tooltip.
 */

export type OwnerTokenAction = "compose" | "split" | "decompose" | "redeem" | "burn";

export interface OwnerTokenNoticeInput {
  action: OwnerTokenAction;
  /** The token kept by the action: the compose survivor, the split parent, the decompose
   *  survivor, or the token being redeemed/burned. */
  actingTokenId: bigint;
  /** Compose only: the other tokens being burned into `actingTokenId`. */
  donorIds?: bigint[];
  /** Display label for a `...To` recipient different from the acting wallet, e.g. `short(address)`.
   *  Omitted (or null) when the result stays with the caller. */
  recipient?: string | null;
  /** The current owner-token id, or null when no Shape currently holds collection ownership. */
  ownerTokenId: bigint | null;
  /** Decompose only: the input that carried collection ownership before the compose being undone
   *  (`ComposeRecordView.ownerTokenFrom`), or null when none did. */
  restoredOwnerTokenId?: bigint | null;
}

export interface OwnerTokenNotice {
  text: string;
  /** "warning" is the permanent, unrecoverable case (redeem/burn of the owner token); it should
   *  render visually distinct from an ordinary "info" ownership-movement notice. */
  severity: "info" | "warning";
}

/** Returns the notices to show for this action, in display order. Empty when the action does not
 *  touch the current owner token at all. */
export function ownerTokenNotices(input: OwnerTokenNoticeInput): OwnerTokenNotice[] {
  const {action, actingTokenId, donorIds = [], recipient, ownerTokenId, restoredOwnerTokenId = null} = input;
  if (ownerTokenId === null) return [];

  switch (action) {
    case "compose": {
      // The survivor already being the owner token is not a move.
      if (ownerTokenId === actingTokenId) return [];
      if (donorIds.includes(ownerTokenId)) {
        return [{text: `Collection ownership moves to Shape #${actingTokenId}.`, severity: "info"}];
      }
      return [];
    }
    case "split": {
      if (ownerTokenId !== actingTokenId) return [];
      const notices: OwnerTokenNotice[] = [
        {text: "Collection ownership moves to the first new Shape.", severity: "info"},
      ];
      if (recipient) {
        notices.push({text: `${recipient} becomes the collection owner.`, severity: "info"});
      }
      return notices;
    }
    case "decompose": {
      if (ownerTokenId !== actingTokenId) return [];
      // The compose record's ownerTokenFrom names the input that carried ownership before the
      // compose being undone. Null means that compose did not move ownership onto the survivor,
      // so decompose leaves it with the survivor and there is nothing to announce.
      if (restoredOwnerTokenId === null) return [];
      const notices: OwnerTokenNotice[] = [
        {text: `Collection ownership moves back to Shape #${restoredOwnerTokenId}.`, severity: "info"},
      ];
      if (recipient) {
        notices.push({text: `${recipient} becomes the collection owner.`, severity: "info"});
      }
      return notices;
    }
    case "redeem":
    case "burn": {
      if (ownerTokenId !== actingTokenId) return [];
      return [
        {text: "This ends collection ownership permanently. No Shape inherits it.", severity: "warning"},
      ];
    }
  }
}
