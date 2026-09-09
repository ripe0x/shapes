import React from "react";
import {formatEther} from "viem";
import {useAccount, useBalance} from "wagmi";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {GRIDS} from "../canonical/denominations";
import {Art, txUrl} from "./ui";
import {localArt, sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import {seedFee, seedMintStart, type SiteData} from "./data";
import type {MintState} from "./SiteApp";
import {formatCountdown, mintOpensIn} from "./mintOpensIn";

// The contract has no batch cap (_mintBatch only requires quantity != 0); 100 is a UI guard
// against a batch too large to fit in one block.
const MAX_MINT_QUANTITY = 100;
const clampQuantity = (n: number) => Math.min(MAX_MINT_QUANTITY, Math.max(1, n));

/** Interval for the selected tier's rotating sample artwork. Off under prefers-reduced-motion. */
const STAGE_CYCLE_MS = 1400;

/** Sample cards shown beside the large preview, all at the selected denomination. */
const ALTERNATE_SAMPLE_COUNT = 3;

const gridText = (di: number) => `${GRIDS[di][0]} × ${GRIDS[di][1]}`;
const markCountText = (di: number) => {
  const marks = GRIDS[di][0] * GRIDS[di][1];
  return marks === 1 ? "1 mark" : `${marks} marks`;
};

/** Sample artwork as a data URI: a preview-only seed stream drawn by the canonical renderer at the
 *  gene the chain would assign that (seed, denomination). Not a chain read. */
function sampleArt(di: number, roll: number): string {
  const seed = sampleSeed(di * 977 + roll * 613 + 1000);
  const wei = DENOMINATIONS[di].wei;
  return localArt(seed, wei, mintGene(seed, wei));
}

/** True once the client reports prefers-reduced-motion. False during server render and the first
 *  client render, so both agree. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The nine denominations as a ladder, densest first. Each row carries a sample card that re-rolls
 *  when the row is hovered or focused; clicking selects the denomination. */
function DenominationRail({sel, onSelect}: {sel: number; onSelect: (i: number) => void}) {
  const [rolls, setRolls] = React.useState<number[]>(() => DENOMINATIONS.map(() => 0));
  const reroll = (i: number) =>
    setRolls((prev) => prev.map((roll, index) => (index === i ? roll + 1 : roll)));
  const arts = React.useMemo(() => rolls.map((roll, i) => sampleArt(i, roll)), [rolls]);

  return (
    <div className="mint-page-rail">
      <p className="launch-kicker">Denomination</p>
      <div className="mint-page-rail-rows">
        {DENOMINATIONS.map((d, i) => (
          <button
            key={d.label}
            type="button"
            className={i === sel ? "mint-page-denom is-selected" : "mint-page-denom"}
            aria-pressed={i === sel}
            onClick={() => onSelect(i)}
            onMouseEnter={() => reroll(i)}
            onFocus={() => reroll(i)}
          >
            <Art src={arts[i]} width={30} />
            <span className="mint-page-denom-value">{d.label} ETH</span>
            <span className="mint-page-denom-grid">{gridText(i)}</span>
            <span className="mint-page-denom-marks">{markCountText(i)}</span>
          </button>
        ))}
      </div>
      <p className="mint-page-note">
        Nine fixed amounts. Nothing between them, nothing above 100 ETH. The amount sets the grid:
        25 marks at the bottom of the ladder, one at the top.
      </p>
    </div>
  );
}

/** Large sample card for the selected denomination plus three alternates at the same denomination.
 *  Every card is drawn locally by the canonical renderer, so it is what the chain would serve for
 *  that seed. */
function SampleStage({sel}: {sel: number}) {
  const reducedMotion = usePrefersReducedMotion();
  const [roll, setRoll] = React.useState(0);
  React.useEffect(() => setRoll(0), [sel]);
  React.useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setRoll((r) => r + 1), STAGE_CYCLE_MS);
    return () => clearInterval(id);
  }, [sel, reducedMotion]);

  const main = React.useMemo(() => sampleArt(sel, roll), [sel, roll]);
  const alternates = React.useMemo(
    () => Array.from({length: ALTERNATE_SAMPLE_COUNT}, (_, i) => sampleArt(sel, roll + 17 * (i + 1))),
    [sel, roll],
  );

  return (
    <div className="mint-page-stage">
      <p className="launch-kicker">Sample at {DENOMINATIONS[sel].label} ETH</p>
      <div className="mint-page-stage-card">
        <Art src={main} alt={`Sample ${DENOMINATIONS[sel].label} ETH Shape`} />
      </div>
      <div className="mint-page-stage-alternates">
        {alternates.map((art, i) => (
          <Art key={i} src={art} />
        ))}
      </div>
      <div className="mint-page-stage-foot">
        <span>
          {gridText(sel)} · {markCountText(sel)}
        </span>
        <button type="button" className="btn-outline mint-page-reroll" onClick={() => setRoll((r) => r + 1)}>
          New samples
        </button>
      </div>
      <p className="mint-page-note">
        Samples, not your Shape. The seed is assigned at mint from the token number and block data,
        and decides the artwork. It has no effect on what the Shape redeems for.
      </p>
    </div>
  );
}

/** The minted cards, drawn from the seeds in the mint receipt, with the transaction link and the
 *  routes out of the mint page. */
function MintReveal({
  minted,
  chainId,
  onOpenToken,
  onOpenMyShapes,
}: {
  minted: NonNullable<MintState["minted"]>;
  chainId: number;
  onOpenToken: (id: bigint) => void;
  onOpenMyShapes: () => void;
}) {
  const denom = DENOMINATIONS[minted.di];
  const first = minted.tokens[0];
  const last = minted.tokens[minted.tokens.length - 1];
  const heading =
    minted.tokens.length === 1
      ? `Shape ${first.id.toString()}`
      : `${minted.tokens.length} Shapes, #${first.id.toString()}–#${last.id.toString()}`;

  return (
    <section className="mint-page-reveal">
      <div className="mint-page-reveal-head">
        <div>
          <p className="launch-kicker">Minted</p>
          <h2 className="mint-page-reveal-title">{heading}</h2>
          <p className="mint-page-reveal-line">
            {denom.label} ETH backing {minted.tokens.length === 1 ? "this Shape" : "each of these Shapes"}.
            Burn one and the contract pays back {denom.label} ETH.
          </p>
        </div>
        <div className="mint-page-reveal-actions">
          <button type="button" className="btn-filled" onClick={() => onOpenToken(first.id)}>
            {minted.tokens.length === 1 ? "Open Shape" : `Open Shape ${first.id.toString()}`}
          </button>
          <button type="button" className="btn-outline" onClick={onOpenMyShapes}>
            My Shapes
          </button>
          <a href={txUrl(minted.tx, chainId)} target="_blank" rel="noreferrer" className="mint-page-reveal-tx">
            {minted.tx.slice(0, 12)}… on evm.now
          </a>
        </div>
      </div>
      <div className={minted.tokens.length === 1 ? "mint-page-reveal-grid is-single" : "mint-page-reveal-grid"}>
        {minted.tokens.map((t) => (
          <button
            key={t.id.toString()}
            type="button"
            className="btn-ghost mint-page-reveal-card"
            onClick={() => onOpenToken(t.id)}
          >
            <Art src={localArt(t.seed, denom.wei, mintGene(t.seed, denom.wei))} />
            <span>#{t.id.toString()}</span>
          </button>
        ))}
      </div>
      <p className="mint-page-note">
        Compose these into a larger denomination, or split one back down, from My Shapes.
      </p>
    </section>
  );
}

export function MintPage({
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
  /** The deployment record, used only to seed the fee and the mint gate before `data` loads; see
   *  `seedFee`/`seedMintStart`. */
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
  // Local text mirrors `qty` so the field can hold an empty or out-of-range string while typing;
  // committing (blur, or a step button) clamps back into range.
  const [quantityText, setQuantityText] = React.useState(String(qty));
  React.useEffect(() => setQuantityText(String(qty)), [qty]);
  const commitQuantity = (raw: string) => {
    const n = Math.round(Number(raw));
    setQty(Number.isFinite(n) && raw.trim() !== "" ? clampQuantity(n) : 1);
  };

  const wei = DENOMINATIONS[sel].wei;
  const fee = seedFee(dep, data, sel);
  const quantity = BigInt(qty);
  const backingTotal = wei * quantity;
  const feeTotal = fee === null ? null : fee * quantity;
  const total = feeTotal === null ? null : backingTotal + feeTotal;

  // One 1s tick drives the "mint opens in" countdown; skipped once open, since mintStart is
  // immutable and cannot start blocking again.
  const [now, setNow] = React.useState(() => Date.now());
  const mintGate = mintOpensIn(now, seedMintStart(dep, data));
  React.useEffect(() => {
    if (mintGate.open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mintGate.open]);

  // The connected account's native balance, to catch a selection that costs more than it holds
  // before the wallet rejects it. Backing plus fee only; gas is left to the wallet.
  const {address} = useAccount();
  const {data: balance} = useBalance({address, chainId});
  const insufficient = connected && balance !== undefined && total !== null && balance.value < total;

  const alert =
    mint.status === "failed" && mint.error
      ? mint.error
      : !mintGate.open
        ? `Minting opens in ${formatCountdown(mintGate.secondsLeft)}.`
        : insufficient && total !== null && balance !== undefined
          ? `Not enough ETH. This mint needs ${formatEther(total)} ETH; the wallet holds ${formatEther(balance.value)} ETH. Choose a lower denomination or quantity.`
          : null;

  const minted = mint.status === "done" ? (mint.minted ?? null) : null;
  const eth = (v: bigint | null) => (v === null ? "—" : `${formatEther(v)} ETH`);

  return (
    <main className="mint-page">
      <div className="mint-page-shell">
        {minted && (
          <MintReveal
            minted={minted}
            chainId={chainId}
            onOpenToken={onOpenToken}
            onOpenMyShapes={onOpenMyShapes}
          />
        )}

        <header className="mint-page-head">
          <div className="mint-page-head-copy">
            <p className="launch-kicker">Mint</p>
            <h1 className="mint-page-title">ETH in, Shape out.</h1>
            <p className="mint-page-lead">
              A Shape is an ERC721 token holding an exact amount of ETH. Burn it and the contract
              pays back that exact amount, to whoever holds it. There is no supply cap and no
              allowlist. Choose one of nine denominations and a quantity; the flat fee is the only
              cost.
            </p>
          </div>
          <dl className="mint-page-stats">
            <div>
              <dt>Status</dt>
              <dd>{mintGate.open ? "Open" : `Opens in ${formatCountdown(mintGate.secondsLeft)}`}</dd>
            </div>
            <div>
              <dt>Fee per Shape</dt>
              <dd>{eth(fee)}</dd>
            </div>
            <div>
              <dt>Reserve</dt>
              <dd>
                {data
                  ? `${formatEther(data.reserve)} ETH backing ${data.supply.toString()} Shapes`
                  : "—"}
              </dd>
            </div>
          </dl>
        </header>

        <div className="mint-page-work">
          <DenominationRail sel={sel} onSelect={setSel} />
          <SampleStage sel={sel} />

          <aside className="mint-page-ticket">
            <p className="launch-kicker">Your mint</p>

            <div className="mint-page-field">
              <span className="mint-page-field-label">Quantity</span>
              <div className="mint-page-stepper">
                <button
                  type="button"
                  className="btn-outline"
                  aria-label="One fewer Shape"
                  onClick={() => setQty(clampQuantity(qty - 1))}
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_MINT_QUANTITY}
                  className="qty-input"
                  aria-label="Shapes to mint"
                  value={quantityText}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setQuantityText(raw);
                    const n = Math.round(Number(raw));
                    if (raw.trim() !== "" && Number.isFinite(n) && n > 0) setQty(n);
                  }}
                  onBlur={(e) => commitQuantity(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-outline"
                  aria-label="One more Shape"
                  onClick={() => setQty(clampQuantity(qty + 1))}
                >
                  +
                </button>
              </div>
            </div>

            <dl className="mint-page-cost">
              <div>
                <dt>
                  Backing <span>redeemable</span>
                </dt>
                <dd>
                  {eth(backingTotal)}
                  {qty > 1 && <em>{qty} × {DENOMINATIONS[sel].label}</em>}
                </dd>
              </div>
              <div>
                <dt>
                  Mint fee <span>spent</span>
                </dt>
                <dd>
                  {eth(feeTotal)}
                  {qty > 1 && fee !== null && <em>{qty} × {formatEther(fee)}</em>}
                </dd>
              </div>
              <div className="mint-page-cost-total">
                <dt>You send</dt>
                <dd>{eth(total)}</dd>
              </div>
            </dl>

            {connected ? (
              <button
                type="button"
                className="btn-filled mint-page-action"
                onClick={onMint}
                disabled={mint.status === "pending" || fee === null || insufficient || !mintGate.open}
              >
                {mint.status === "pending"
                  ? "Waiting for confirmation"
                  : !mintGate.open
                    ? "Mint not open yet"
                    : insufficient
                      ? "Insufficient balance"
                      : qty > 1
                        ? `Mint ${qty} Shapes`
                        : "Mint one Shape"}
              </button>
            ) : (
              <button type="button" className="btn-filled mint-page-action" onClick={onConnect}>
                Connect wallet
              </button>
            )}

            {alert ? (
              <p className="mint-page-alert">{alert}</p>
            ) : (
              <p className="mint-page-note">
                {connected
                  ? `Payment is exact: ${eth(total)} for ${eth(backingTotal)} of redeemable backing. Over and under both revert.`
                  : "Connect a wallet to mint. Payment is exact; over and under both revert."}
              </p>
            )}
          </aside>
        </div>

        <section className="mint-page-facts">
          <div>
            <p className="launch-kicker">Backing</p>
            <p>
              The contract holds the ETH and does nothing else with it: no lending, no staking, no
              yield. Every Shape of a denomination redeems for exactly that denomination, for as
              long as it exists.
            </p>
          </div>
          <div>
            <p className="launch-kicker">Density</p>
            <p>
              The denomination sets the grid. 0.01 ETH is 25 marks across 5 × 5; 100 ETH is one mark
              alone on a black field. Higher value means less.
            </p>
          </div>
          <div>
            <p className="launch-kicker">After the mint</p>
            <p>
              Hold it, transfer it, or compose several Shapes into a larger denomination and split
              that back down. Your Shapes are at My Shapes.{" "}
              <a href="/docs/minting">Minting reference</a>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
