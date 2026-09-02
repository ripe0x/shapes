import React from "react";
import {formatEther} from "viem";
import {useAccount, useBalance} from "wagmi";
import {DENOMINATIONS} from "../chain/abi";
import {GRIDS, LABELS} from "../canonical/denominations";
import {C, FONT, SANS} from "./theme";
import {Art, txUrl} from "./ui";
import {localArt, sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import type {SiteData} from "./data";
import type {MintState} from "./SiteApp";

const marksText = (di: number) => {
  const [c, r] = GRIDS[di];
  return c * r === 1 ? "1 mark" : `${c * r} marks`;
};
const gridText = (di: number) => `${GRIDS[di][0]} × ${GRIDS[di][1]}`;

/** One tier card in the mint page's denomination grid. Hovering cycles its thumbnail every
 *  300ms starting from a random frame, matching the landing page's tier cards. Clicking selects
 *  the tier. */
function TierCard({
  i,
  d,
  sel,
  onSelect,
}: {
  i: number;
  d: {label: string; wei: bigint};
  sel: number;
  onSelect: (i: number) => void;
}) {
  const [hover, setHover] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const hoverBase = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const enter = () => {
    if (timer.current) clearInterval(timer.current);
    hoverBase.current = 1 + Math.floor(Math.random() * 4096);
    setHover(true);
    setTick(0);
    timer.current = setInterval(() => setTick((t) => t + 1), 300);
  };
  const leave = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setHover(false);
    setTick(0);
  };
  React.useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const t = hover ? hoverBase.current + tick : 0;
  const seed = sampleSeed(1000 + i + t * 613);
  const art = localArt(seed, d.wei, mintGene(seed, d.wei));

  return (
    <button
      type="button"
      className="tier"
      aria-pressed={sel === i}
      onClick={() => onSelect(i)}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <div className="tier-value">
        <strong>{d.label}</strong>
        <span>ETH</span>
      </div>
      <img className="tier-art" src={art} alt="" />
      <div className="tier-cost">
        <span>{gridText(i)} grid</span>
        <strong>{marksText(i)}</strong>
      </div>
    </button>
  );
}

export function MintView({
  data,
  chainId,
  connected,
  sel,
  setSel,
  qty,
  setQty,
  mint,
  onMint,
  onOpenToken,
}: {
  data: SiteData | null;
  chainId: number;
  connected: boolean;
  sel: number;
  setSel: (i: number) => void;
  qty: number;
  setQty: (n: number) => void;
  mint: MintState;
  onMint: () => void;
  onOpenToken: (id: bigint) => void;
}) {
  const [sample, setSample] = React.useState(0);
  React.useEffect(() => setSample(0), [sel]);

  // The sample preview cycles on its own every 1.2s. `manual` restarts the interval after a
  // step button press so the auto-advance does not override a click a moment later. Off under
  // prefers-reduced-motion; the step buttons still work.
  const [manual, setManual] = React.useState(0);
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setSample((s) => s + 1), 1200);
    return () => clearInterval(id);
  }, [sel, manual]);
  const step = (delta: number) => {
    setSample((s) => s + delta);
    setManual((m) => m + 1);
  };

  const wei = DENOMINATIONS[sel].wei;
  const fee = data?.fees[sel] ?? null;
  const q = BigInt(qty);
  const sampleNo = ((sample % 12) + 12) % 12;
  const minted = mint.minted ?? null;

  // The connected account's native balance, to catch a selection that costs more than it holds
  // before the wallet rejects it. This is the backing plus fee only; gas is left to the wallet.
  const {address} = useAccount();
  const {data: balance} = useBalance({address, chainId});
  const total = fee === null ? null : (wei + fee) * q;
  const insufficient =
    connected && balance !== undefined && total !== null && balance.value < total;

  return (
    <main className="mint-page">
      <section className="launch-section launch-about">
        <div>
          <p className="launch-kicker">Mint</p>
          <h2>
            ETH in, Shape out.
            <br />
            Shape burned, ETH returned.
          </h2>
        </div>
        <div className="launch-prose">
          <p>
            A Shape holds an exact amount of ETH and gives back the same amount, exactly. Nine
            denominations, {LABELS[0]} to {LABELS[LABELS.length - 1]} ETH. Higher value, fewer
            marks.
          </p>
        </div>
      </section>

      <section className="launch-section">
        <div className="launch-section-heading">
          <div>
            <p className="launch-kicker">Nine fixed tiers</p>
            <h2>Choose a value</h2>
          </div>
        </div>
        <div className="tier-grid">
          {DENOMINATIONS.map((d, i) => (
            <TierCard key={d.label} i={i} d={d} sel={sel} onSelect={setSel} />
          ))}
        </div>
      </section>

      <section className="launch-section">
        <p className="launch-kicker">Mint</p>
        <div style={{display: "flex", flexWrap: "wrap", gap: 44, alignItems: "flex-start"}}>
          <div style={{flex: "0 0 180px", width: 180}}>
            <Art src={localArt(sampleSeed(6100 + sel * 97 + sampleNo * 7), wei, mintGene(sampleSeed(6100 + sel * 97 + sampleNo * 7), wei))} />
            <div style={{marginTop: 10, display: "flex", alignItems: "center", gap: 8}}>
              <button type="button" className="btn-step" onClick={() => step(-1)} style={{width: 26, height: 24}}>
                ‹
              </button>
              <button type="button" className="btn-step" onClick={() => step(1)} style={{width: 26, height: 24}}>
                ›
              </button>
              <span style={{marginLeft: "auto", fontSize: 10, letterSpacing: "0.1em", color: C.faint}}>
                SAMPLE {sampleNo + 1} / 12
              </span>
            </div>
            <div style={{marginTop: 8, fontSize: 10, lineHeight: 1.6, color: C.faint}}>
              Sample outputs at {DENOMINATIONS[sel].label} ETH. Your seed is set at mint.
            </div>
          </div>

          <div style={{flex: "1 1 360px", minWidth: 0}}>
            <div style={{display: "grid", gridTemplateColumns: "130px auto", gap: "9px 28px", fontSize: 13}}>
              <div style={{color: C.muted}}>selected</div>
              <div>
                {DENOMINATIONS[sel].label} ETH · {gridText(sel)} · {marksText(sel)}
              </div>
              <div style={{color: C.muted}}>quantity</div>
              <div style={{display: "flex", alignItems: "center", gap: 0}}>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => setQty(Math.max(1, qty - 1))}
                  style={{width: 28, height: 28, padding: 0}}
                >
                  −
                </button>
                <div
                  style={{
                    minWidth: 40,
                    height: 28,
                    border: `1px solid ${C.border}`,
                    borderLeft: 0,
                    borderRight: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                  }}
                >
                  {qty}
                </div>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => setQty(Math.min(20, qty + 1))}
                  style={{width: 28, height: 28, padding: 0}}
                >
                  +
                </button>
              </div>
              <div style={{color: C.muted}}>backing</div>
              <div>
                {formatEther(wei * q)} ETH
                {qty > 1 && <span style={{color: C.muted}}> · {qty} × {DENOMINATIONS[sel].label}</span>}
              </div>
              <div style={{color: C.muted}}>mint fee</div>
              <div>
                {fee === null ? "" : `${formatEther(fee * q)} ETH`}
                {fee !== null && qty > 1 && <span style={{color: C.muted}}> · {qty} × {formatEther(fee)}</span>}
              </div>
            </div>

            <div
              style={{
                margin: "18px 0 0",
                paddingTop: 14,
                borderTop: `1px solid ${C.border}`,
                display: "grid",
                gridTemplateColumns: "130px auto",
                gap: 28,
                fontSize: 15,
              }}
            >
              <div style={{color: C.muted, fontSize: 13, paddingTop: 2}}>total</div>
              <div>{fee === null ? "" : `${formatEther((wei + fee) * q)} ETH`}</div>
            </div>

            <div style={{marginTop: 30, display: "flex", flexWrap: "wrap", gap: 12}}>
              <button
                type="button"
                className="btn-filled"
                onClick={onMint}
                disabled={!connected || mint.status === "pending" || fee === null || insufficient}
                style={{padding: "11px 30px"}}
              >
                {mint.status === "pending"
                  ? "Waiting for confirmation"
                  : insufficient
                    ? "Insufficient balance"
                    : qty > 1
                      ? `Mint ${qty}`
                      : "Mint"}
              </button>
            </div>
            <p
              style={{
                margin: "16px 0 0",
                fontSize: 12,
                lineHeight: 1.7,
                color: insufficient || (mint.status === "failed" && mint.error) ? C.ink : C.muted,
                maxWidth: "62ch",
              }}
            >
              {mint.status === "failed" && mint.error
                ? mint.error
                : insufficient && total !== null && balance !== undefined
                  ? `Not enough ETH. This ${qty > 1 ? `${qty}× mint` : "mint"} needs ${formatEther(total)} ETH; your balance is ${formatEther(balance.value)} ETH. Choose a lower denomination or quantity.`
                  : connected && fee !== null
                    ? `You send ${formatEther((wei + fee) * q)} ETH. The redemption value is ${formatEther(wei * q)} ETH.`
                    : "Connect a wallet to mint. Browsing needs no wallet."}
            </p>
          </div>
        </div>

        <div style={{marginTop: 40, fontFamily: FONT, fontSize: 11, color: C.muted}}>
          {data
            ? `The contract holds ${formatEther(data.reserve)} ETH backing ${data.supply.toString()} Shapes.`
            : ""}
        </div>
      </section>

      {mint.status === "done" && minted && minted.tokens.length === 1 && (
        <section className="launch-section">
          <p className="launch-kicker">Minted</p>
          <div style={{display: "flex", flexWrap: "wrap", gap: 40, alignItems: "flex-start"}}>
            <Art src={localArt(minted.tokens[0].seed, DENOMINATIONS[minted.di].wei, mintGene(minted.tokens[0].seed, DENOMINATIONS[minted.di].wei))} width={250} />
            <div style={{flex: "1 1 300px", minWidth: 0}}>
              <div style={{fontSize: 26}}>Shape {minted.tokens[0].id.toString()}</div>
              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "110px minmax(0, 1fr)",
                  gap: "8px 24px",
                  fontSize: 13,
                }}
              >
                <div style={{color: C.muted}}>denomination</div>
                <div>{DENOMINATIONS[minted.di].label} ETH</div>
                <div style={{color: C.muted}}>grid</div>
                <div>
                  {gridText(minted.di)} · {marksText(minted.di)}
                </div>
                <div style={{color: C.muted}}>seed</div>
                <div style={{overflowWrap: "anywhere"}}>
                  0x{minted.tokens[0].seed.toString(16).padStart(64, "0").slice(0, 16)}…
                </div>
                <div style={{color: C.muted}}>transaction</div>
                <div style={{overflowWrap: "anywhere"}}>
                  <a href={txUrl(minted.tx, chainId)} target="_blank" rel="noreferrer" style={{fontSize: 13}}>
                    {minted.tx.slice(0, 12)}… on evm.now
                  </a>
                </div>
              </div>
              <p style={{margin: "22px 0 0", fontFamily: SANS, fontSize: 14, lineHeight: 1.6, color: C.bodyDim, maxWidth: "52ch"}}>
                The contract holds {DENOMINATIONS[minted.di].label} ETH for this Shape. Burn it and
                you receive {DENOMINATIONS[minted.di].label} ETH.
              </p>
              <button
                type="button"
                className="btn-outline"
                onClick={() => onOpenToken(minted.tokens[0].id)}
                style={{marginTop: 22, padding: "10px 20px"}}
              >
                Open Shape
              </button>
            </div>
          </div>
        </section>
      )}

      {mint.status === "done" && minted && minted.tokens.length > 1 && (
        <section className="launch-section">
          <p className="launch-kicker">Minted</p>
          <div style={{fontSize: 26}}>
            {minted.tokens.length} Shapes, #{minted.tokens[0].id.toString()}–#
            {minted.tokens[minted.tokens.length - 1].id.toString()}
          </div>
          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "110px minmax(0, 1fr)",
              gap: "8px 24px",
              fontSize: 13,
            }}
          >
            <div style={{color: C.muted}}>denomination</div>
            <div>{DENOMINATIONS[minted.di].label} ETH each</div>
            <div style={{color: C.muted}}>grid</div>
            <div>
              {gridText(minted.di)} · {marksText(minted.di)}
            </div>
            <div style={{color: C.muted}}>transaction</div>
            <div style={{overflowWrap: "anywhere"}}>
              <a href={txUrl(minted.tx, chainId)} target="_blank" rel="noreferrer" style={{fontSize: 13}}>
                {minted.tx.slice(0, 12)}… on evm.now
              </a>
            </div>
          </div>
          <div style={{marginTop: 28, display: "flex", flexWrap: "wrap", gap: "28px 22px"}}>
            {minted.tokens.map((m) => (
              <button
                key={m.id.toString()}
                type="button"
                className="btn-ghost"
                onClick={() => onOpenToken(m.id)}
                style={{display: "block", textAlign: "left", flex: "0 0 140px", width: 140}}
              >
                <Art src={localArt(m.seed, DENOMINATIONS[minted.di].wei, mintGene(m.seed, DENOMINATIONS[minted.di].wei))} />
                <div style={{marginTop: 8, fontSize: 11, color: C.muted}}>#{m.id.toString()}</div>
              </button>
            ))}
          </div>
          <p style={{margin: "24px 0 0", fontFamily: SANS, fontSize: 14, lineHeight: 1.6, color: C.bodyDim, maxWidth: "52ch"}}>
            The contract holds {DENOMINATIONS[minted.di].label} ETH for each of these Shapes. Burn
            one and you receive {DENOMINATIONS[minted.di].label} ETH.
          </p>
        </section>
      )}
    </main>
  );
}
