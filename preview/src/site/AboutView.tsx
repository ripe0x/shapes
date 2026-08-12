import {C} from "./theme";
import {Section} from "./ui";
import {DenomLadder} from "./MintView";
import {ABOUT_FACTS} from "./copy";
import type {SiteData} from "./data";

export function AboutView({data}: {data: SiteData | null}) {
  return (
    <main>
      <div style={{padding: "64px 48px 56px", borderBottom: `1px solid ${C.rule}`}}>
        <div style={{fontSize: 22, lineHeight: 1.62, maxWidth: "54ch"}}>
          ETH in, Shape out.
          <br />
          Shape burned, the same ETH out.
        </div>
      </div>

      <Section title="DENOMINATIONS">
        <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.78, maxWidth: "70ch", color: C.body}}>
          Nine denominations, permanent. Every other amount is rejected. Value sets the grid: the
          more ETH a Shape holds, the fewer marks are drawn.
        </p>
        <DenomLadder fees={data?.fees ?? null} />
      </Section>

      {ABOUT_FACTS.map((f) => (
        <Section key={f.k} title={f.k}>
          <div style={{fontSize: 13, lineHeight: 1.78, maxWidth: "70ch", color: C.body}}>{f.v}</div>
        </Section>
      ))}

      <Section title="CONTRACT" pad="24px 48px 72px 32px" last>
        <div style={{display: "grid", gridTemplateColumns: "110px minmax(0, 1fr)", gap: "10px 24px", fontSize: 13}}>
          <div style={{color: C.muted}}>mainnet</div>
          <div>not deployed</div>
          <div style={{color: C.muted}}>sepolia</div>
          <div>not deployed</div>
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
