import React from "react";
import {formatEther} from "viem";
import {useAccount, useBalance} from "wagmi";
import {DENOMINATIONS} from "../chain/abi";
import {GRIDS} from "../canonical/denominations";
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

// The contract has no batch cap (_mintBatch only requires quantity != 0); 100 is a UI guard
// against a batch too large to fit in one block.
const MAX_QTY = 100;
const clampQty = (n: number) => Math.min(MAX_QTY, Math.max(1, n));

/** The nine-row denomination ladder. Hovering a row cycles its thumbnail every 300ms starting
 *  from a random frame; clicking a row selects it. */
function DenomLadder({sel, onSelect}: {sel: number; onSelect: (i: number) => void}) {
  const [hover, setHover] = React.useState(-1);
  const [tick, setTick] = React.useState(0);
  // Random per hover, so each hover shows a different sample sequence. Non-zero, so the first
  // hovered frame already differs from the resting artwork.
  const hoverBase = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Hovering a row swaps its thumbnail immediately and then cycles every 300ms. One timer at
  // a time.
  const enter = (i: number) => {
    if (timer.current) clearInterval(timer.current);
    hoverBase.current = 1 + Math.floor(Math.random() * 4096);
    setHover(i);
    setTick(0);
    timer.current = setInterval(() => setTick((t) => t + 1), 300);
  };
  const leave = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setHover(-1);
    setTick(0);
  };
  React.useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  return (
    <div style={{borderTop: `1px solid ${C.rule}`}}>
      {DENOMINATIONS.map((d, i) => {
        const t = hover === i ? hoverBase.current + tick : 0;
        const sampleArtSeed = sampleSeed(1000 + i + t * 613);
        const art = localArt(sampleArtSeed, d.wei, mintGene(sampleArtSeed, d.wei));
        return (
          <button
            key={d.label}
            type="button"
            className="row-denom"
            aria-pressed={sel === i}
            onClick={() => onSelect(i)}
            onMouseEnter={() => enter(i)}
            onMouseLeave={leave}
            style={{
              display: "grid",
              gridTemplateColumns: "34px 96px 78px minmax(0, 1fr)",
              gap: 24,
              alignItems: "center",
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              border: 0,
              borderBottom: `1px solid ${C.ruleInner}`,
              background: sel === i ? C.row : "transparent",
              color: sel === i ? C.ink : C.bodyDim,
              cursor: "pointer",
            }}
          >
            <Art src={art} width={34} />
            <div>{d.label} ETH</div>
            <div style={{color: C.muted}}>{gridText(i)}</div>
            <div style={{color: C.muted}}>{marksText(i)}</div>
          </button>
        );
      })}
    </div>
  );
}

export function MintPanel({
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
  onConnect,
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
  onConnect: () => void;
}) {
  const [sample, setSample] = React.useState(0);
  React.useEffect(() => setSample(0), [sel]);

  // The sample preview auto-rotates through the 12 samples every 1.2s. Off under
  // prefers-reduced-motion.
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setSample((s) => s + 1), 1200);
    return () => clearInterval(id);
  }, [sel]);

  // Local text mirrors `qty` so the field can hold an empty or out-of-range string while
  // typing; committing (blur, or a step button) clamps back into range.
  const [qtyText, setQtyText] = React.useState(String(qty));
  React.useEffect(() => setQtyText(String(qty)), [qty]);
  const commitQty = (raw: string) => {
    const n = Math.round(Number(raw));
    setQty(Number.isFinite(n) && raw.trim() !== "" ? clampQty(n) : 1);
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
  const statusText =
    mint.status === "failed" && mint.error
      ? mint.error
      : insufficient && total !== null && balance !== undefined
        ? `Not enough ETH. This ${qty > 1 ? `${qty}× mint` : "mint"} needs ${formatEther(total)} ETH; your balance is ${formatEther(balance.value)} ETH. Choose a lower denomination or quantity.`
        : connected && fee !== null
          ? `You send ${formatEther((wei + fee) * q)} ETH. The redemption value is ${formatEther(wei * q)} ETH.`
          : null;

  return (
    <div style={{fontFamily: FONT, width: "100%"}}>
      <div className="mint-panel">
        <div className="mint-panel-ladder">
          <DenomLadder sel={sel} onSelect={setSel} />
        </div>

        <div className="mint-panel-side">
          <div style={{display: "flex", flexWrap: "wrap", gap: 44, alignItems: "flex-start"}}>
            <div style={{flex: "0 0 260px", width: 260}}>
              <Art src={localArt(sampleSeed(6100 + sel * 97 + sampleNo * 7), wei, mintGene(sampleSeed(6100 + sel * 97 + sampleNo * 7), wei))} width={260} />
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
                    onClick={() => setQty(clampQty(qty - 1))}
                    style={{width: 28, height: 28, padding: 0}}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_QTY}
                    className="qty-input"
                    value={qtyText}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setQtyText(raw);
                      const n = Math.round(Number(raw));
                      if (raw.trim() !== "" && Number.isFinite(n) && n > 0) setQty(n);
                    }}
                    onBlur={(e) => commitQty(e.target.value)}
                    style={{
                      minWidth: 40,
                      height: 28,
                      border: `1px solid ${C.border}`,
                      borderLeft: 0,
                      borderRight: 0,
                      textAlign: "center",
                      fontSize: 13,
                      fontFamily: FONT,
                      color: C.ink,
                      background: "transparent",
                      padding: 0,
                    }}
                  />
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => setQty(clampQty(qty + 1))}
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
                {!connected ? (
                  <button type="button" className="btn-filled" onClick={onConnect} style={{padding: "11px 30px"}}>
                    Connect wallet
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-filled"
                    onClick={onMint}
                    disabled={mint.status === "pending" || fee === null || insufficient}
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
                )}
              </div>
              {statusText && (
                <p
                  style={{
                    margin: "16px 0 0",
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: insufficient || (mint.status === "failed" && mint.error) ? C.ink : C.muted,
                    maxWidth: "62ch",
                  }}
                >
                  {statusText}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {mint.status === "done" && minted && minted.tokens.length === 1 && (
        <div style={{marginTop: 56}}>
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
        </div>
      )}

      {mint.status === "done" && minted && minted.tokens.length > 1 && (
        <div style={{marginTop: 56}}>
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
        </div>
      )}
    </div>
  );
}
