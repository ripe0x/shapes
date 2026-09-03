import React from "react";
import {names} from "../chain/names";
import {short} from "./ui";

/**
 * The address's primary name across ENS, GNS and WNS, or null while it is unknown and when the
 * address has none. Resolution starts in an effect, so a server render and the client render that
 * must match it both begin with no name; a cached answer arrives on the first commit without a
 * network request.
 */
export function useName(address: string | undefined): string | null {
  const [name, setName] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!address) {
      setName(null);
      return;
    }
    let cancelled = false;
    setName(names.peek(address) ?? null);
    void names.resolve(address).then((resolved) => {
      if (!cancelled) setName(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return address ? name : null;
}

/** The address's name once resolved, the short address form until then and when it has none. */
export function useDisplayName(address: string | undefined): string {
  const name = useName(address);
  if (!address) return "";
  return name ?? short(address);
}
