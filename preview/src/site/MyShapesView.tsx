import {C} from "./theme";
import {Section} from "./ui";
import {AddressName} from "./AddressName";
import {ShapeGrid} from "./GalleryView";
import type {SiteData} from "./data";
import {composeRung} from "./composeSelection";

export function filterOwnedTokens<T extends {owner: string}>(tokens: T[], address: string): T[] {
  return tokens.filter((token) => token.owner.toLowerCase() === address.toLowerCase());
}

export function MyShapesView({
  data,
  address,
  connected,
  onConnect,
  onOpenToken,
  onCompose,
}: {
  data: SiteData | null;
  address: `0x${string}` | undefined;
  connected: boolean;
  onConnect: () => void;
  onOpenToken: (id: bigint) => void;
  onCompose: () => void;
}) {
  const tokens = address ? filterOwnedTokens(data?.tokens ?? [], address) : [];
  const composeAvailable = tokens.some((token) => {
    const rung = composeRung(token.di);
    return !!rung && tokens.filter((candidate) => candidate.di === token.di).length >= rung.totalShapes;
  });

  if (!connected || !address) {
    return (
      <main>
        <Section title="MY SHAPES">
          <div style={{fontSize: 15, lineHeight: 1.7}}>
            Connect a wallet to see the Shapes it currently owns.
          </div>
          <button
            type="button"
            className="btn-filled"
            onClick={onConnect}
            style={{marginTop: 24, padding: "10px 18px", letterSpacing: "0.08em"}}
          >
            CONNECT WALLET
          </button>
        </Section>
      </main>
    );
  }

  return (
    <main>
      <Section title="MY SHAPES">
        <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 20}}>
          <div>
            <div style={{fontSize: 15}}>
              {data
                ? `${tokens.length} Shape${tokens.length === 1 ? "" : "s"}, newest first.`
                : "Reading the chain…"}
            </div>
            <AddressName address={address} style={{marginTop: 8, color: C.muted, fontSize: 11, display: "block"}} />
          </div>
          <div className="shape-mode-toggle" role="group" aria-label="My Shapes mode">
            <button type="button" aria-pressed={true}>BROWSE</button>
            <button type="button" aria-pressed={false} disabled={!data || !composeAvailable} onClick={onCompose}>
              COMPOSE
            </button>
          </div>
        </div>
        {data && !composeAvailable && tokens.length > 0 && (
          <div style={{marginTop: 14, color: C.muted, fontSize: 11}}>
            You need a complete set of matching Shapes to compose the next denomination.
          </div>
        )}
      </Section>
      {data && tokens.length === 0 ? (
        <div className="shape-grid-empty">This wallet does not currently own any Shapes.</div>
      ) : (
        <ShapeGrid tokens={tokens} ownerTokenId={data?.ownerToken ?? null} onOpenToken={onOpenToken} />
      )}
    </main>
  );
}
