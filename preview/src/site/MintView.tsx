import {MintPage} from "./MintPage";
import type {Deployment} from "../chain/abi";
import type {SiteData} from "./data";
import type {MintState} from "./SiteApp";

/** The /mint route. The landing page embeds `MintPanel` instead; this route renders the full-page
 *  mint experience. */
export function MintView({
  data,
  dep,
  chainId,
  connected,
  sel,
  setSel,
  qty,
  setQty,
  mint,
  onMint,
  onOpenToken,
  onOpenMyShapes,
  onConnect,
}: {
  data: SiteData | null;
  dep?: Deployment;
  chainId: number;
  connected: boolean;
  sel: number;
  setSel: (i: number) => void;
  qty: number;
  setQty: (n: number) => void;
  mint: MintState;
  onMint: () => void;
  onOpenToken: (id: bigint) => void;
  onOpenMyShapes: () => void;
  onConnect: () => void;
}) {
  return (
    <MintPage
      data={data}
      dep={dep}
      chainId={chainId}
      connected={connected}
      sel={sel}
      setSel={setSel}
      qty={qty}
      setQty={setQty}
      mint={mint}
      onMint={onMint}
      onOpenToken={onOpenToken}
      onOpenMyShapes={onOpenMyShapes}
      onConnect={onConnect}
    />
  );
}
