import {MintPanel} from "./MintPanel";
import type {SiteData} from "./data";
import type {Deployment} from "../chain/abi";
import type {MintState} from "./SiteApp";

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
  onConnect,
}: {
  data: Pick<SiteData, "fees" | "mintStart"> | null;
  dep: Deployment;
  chainId: number;
  connected: boolean;
  sel: number;
  setSel: (i: number) => void;
  qty: number;
  setQty: (n: number) => void;
  mint: MintState;
  onMint: () => void;
  onOpenToken: (id: bigint) => void;
  onConnect: () => void;
}) {
  return (
    <main className="mint-page">
      <section className="launch-section">
        <p className="launch-kicker">Mint</p>
        <MintPanel
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
          onConnect={onConnect}
        />
      </section>
    </main>
  );
}
