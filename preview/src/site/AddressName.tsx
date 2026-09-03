import React from "react";
import {useName} from "./useDisplayName";
import {short} from "./ui";

/**
 * An address as its primary name across ENS, GNS and WNS, or the short address form when it has
 * none. The title attribute always carries the full address.
 */
export function AddressName({
  address,
  showAddress = false,
  style,
}: {
  address: string;
  /** Append the short address after the name, for places that identify the account exactly. */
  showAddress?: boolean;
  style?: React.CSSProperties;
}) {
  const name = useName(address);
  const abbreviated = short(address);
  return (
    <span title={address} style={style}>
      {name ?? abbreviated}
      {name && showAddress ? ` ${abbreviated}` : null}
    </span>
  );
}
