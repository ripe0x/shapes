import {C} from "./theme";
import {Section, short} from "./ui";
import {ShapeGrid} from "./GalleryView";
import type {SiteData} from "./data";

export function filterOwnedTokens<T extends {owner: string}>(tokens: T[], address: string): T[] {
  return tokens.filter((token) => token.owner.toLowerCase() === address.toLowerCase());
}

export function MyShapesView({
  data,
  address,
  connected,
  onConnect,
  onOpenToken,
}: {
  data: SiteData | null;
  address: `0x${string}` | undefined;
  connected: boolean;
  onConnect: () => void;
  onOpenToken: (id: bigint) => void;
}) {
  const tokens = address ? filterOwnedTokens(data?.tokens ?? [], address) : [];

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
        <div style={{fontSize: 15}}>
          {data
            ? `${tokens.length} Shape${tokens.length === 1 ? "" : "s"}, newest first.`
            : "Reading the chain…"}
        </div>
        <div style={{marginTop: 8, color: C.muted, fontSize: 11}}>{short(address)}</div>
      </Section>
      {data && tokens.length === 0 ? (
        <div style={{padding: 48, color: C.muted, fontSize: 13}}>
          This wallet does not currently own any Shapes.
        </div>
      ) : (
        <ShapeGrid tokens={tokens} onOpenToken={onOpenToken} />
      )}
    </main>
  );
}
