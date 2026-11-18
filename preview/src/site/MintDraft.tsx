"use client";

import React from "react";

export interface MintBootstrap {
  fees: bigint[];
  mintStart: bigint;
}

interface MintDraft {
  sel: number;
  setSel: React.Dispatch<React.SetStateAction<number>>;
  qty: number;
  setQty: React.Dispatch<React.SetStateAction<number>>;
  qtyText: string;
  setQtyText: React.Dispatch<React.SetStateAction<string>>;
  quantityFocused: boolean;
  setQuantityFocused: React.Dispatch<React.SetStateAction<boolean>>;
  bootstrap: MintBootstrap | null;
  connectRequested: boolean;
  requestConnect: () => void;
  consumeConnect: () => void;
}

const MintDraftContext = React.createContext<MintDraft | null>(null);

function useDraftState(bootstrap: MintBootstrap | null): MintDraft {
  const [sel, setSel] = React.useState(0);
  const [quantity, setQuantity] = React.useState({qty: 1, qtyText: "1"});
  const {qty, qtyText} = quantity;
  const setQty = React.useCallback<React.Dispatch<React.SetStateAction<number>>>((next) => {
    setQuantity((previous) => {
      const value = typeof next === "function" ? next(previous.qty) : next;
      return value === previous.qty ? previous : {qty: value, qtyText: String(value)};
    });
  }, []);
  const setQtyText = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
    setQuantity((previous) => ({...previous,
      qtyText: typeof next === "function" ? next(previous.qtyText) : next,
    }));
  }, []);
  const [quantityFocused, setQuantityFocused] = React.useState(false);
  const [connectRequested, setConnectRequested] = React.useState(false);
  const requestConnect = React.useCallback(() => setConnectRequested(true), []);
  const consumeConnect = React.useCallback(() => setConnectRequested(false), []);
  return React.useMemo(() => ({sel, setSel, qty, setQty, qtyText, setQtyText, quantityFocused, setQuantityFocused, bootstrap, connectRequested, requestConnect, consumeConnect}),
    [sel, qty, setQty, qtyText, setQtyText, quantityFocused, bootstrap, connectRequested, requestConnect, consumeConnect]);
}

/** Keeps a user's early choices and Connect request when the wallet-backed app takes over. */
export function MintDraftProvider({bootstrap, children}: {
  bootstrap: MintBootstrap | null;
  children: React.ReactNode;
}) {
  const draft = useDraftState(bootstrap);
  return <MintDraftContext.Provider value={draft}>{children}</MintDraftContext.Provider>;
}

export function useOptionalMintDraft(): MintDraft | null {
  return React.useContext(MintDraftContext);
}

export function useMintDraft(): MintDraft {
  const shared = useOptionalMintDraft();
  // The standalone Vite host has no early bootstrap surface and retains its local draft.
  const local = useDraftState(null);
  return shared ?? local;
}
