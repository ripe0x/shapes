import {C, SANS} from "./theme";
import {Section} from "./ui";
import {DenomLadder} from "./MintView";
import {ABOUT_FACTS} from "./copy";
import type {Deployment} from "../chain/abi";
import type {SiteData} from "./data";
import {addrUrl, short} from "./ui";

export function AboutView({dep, data}: {dep: Deployment; data: SiteData | null}) {
  const artist = data?.artist ?? dep.artist ?? null;
  const deployedOn = (chainId: number) =>
    dep.chainId === chainId ? (
      <a href={addrUrl(dep.shapes, chainId)} target="_blank" rel="noreferrer" style={{fontSize: 13}}>
        {short(dep.shapes)}
      </a>
    ) : (
      "not deployed"
    );
  return (
    <main>
      <div style={{padding: "64px 48px 56px", borderBottom: `1px solid ${C.rule}`}}>
        <div style={{fontFamily: SANS, fontSize: 22, lineHeight: 1.62, maxWidth: "54ch"}}>
          ETH in, Shape out.
          <br />
          Shape burned, ETH returned.
        </div>
      </div>

      <Section title="DENOMINATIONS">
        <p style={{margin: "0 0 22px", fontFamily: SANS, fontSize: 14, lineHeight: 1.6, maxWidth: "70ch", color: C.body}}>
          Nine denominations, permanent. Every other amount is rejected. Value sets the grid: the
          more ETH a Shape holds, the fewer marks are drawn.
        </p>
        <DenomLadder />
      </Section>

      {ABOUT_FACTS.map((f) => (
        <Section key={f.k} title={f.k}>
          <div style={{fontFamily: SANS, fontSize: 14, lineHeight: 1.6, maxWidth: "70ch", color: C.body}}>{f.v}</div>
        </Section>
      ))}

      <Section title="CONTRACT" pad="24px 48px 72px 32px" last>
        <div style={{display: "grid", gridTemplateColumns: "110px minmax(0, 1fr)", gap: "10px 24px", fontSize: 13}}>
          <div style={{color: C.muted}}>mainnet</div>
          <div>{deployedOn(1)}</div>
          <div style={{color: C.muted}}>sepolia</div>
          <div>{deployedOn(11155111)}</div>
          <div style={{color: C.muted}}>artist</div>
          <div>
            {artist === null ? (
              "not available on this deployment"
            ) : (
              <a href={addrUrl(artist, dep.chainId)} target="_blank" rel="noreferrer" style={{fontSize: 13}}>
                {short(artist)}
              </a>
            )}
          </div>
          <div style={{color: C.muted}}>signature</div>
          <div>
            {data == null ? (
              "loading"
            ) : data.artistReleaseHash === null ? (
              "not available on this deployment"
            ) : (
              <a href={addrUrl(dep.shapes, dep.chainId)} target="_blank" rel="noreferrer" style={{fontSize: 13}}>
                {data.artistAttested
                  ? `signed · ${short(data.artistReleaseHash)}`
                  : "not signed yet"}
              </a>
            )}
          </div>
          <div style={{color: C.muted}}>source</div>
          <div>
            <a href="https://github.com/ripe0x/shapes" target="_blank" rel="noreferrer" style={{fontSize: 13}}>
              github.com/ripe0x/shapes
            </a>
          </div>
        </div>
      </Section>
    </main>
  );
}
