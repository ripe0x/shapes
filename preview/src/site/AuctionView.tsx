import React from "react";
import {formatEther} from "viem";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {C} from "./theme";
import {Section, Art, Modal, short, txUrl} from "./ui";
import {localArt} from "./art";
import {
  breakdown,
  formatCountdown,
  isSettleable,
  lotIsAShape,
  secondsLeft,
  unitsToEth,
  UNIT,
  type AuctionState,
} from "./auction";
import type {SiteData, SiteToken} from "./data";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Ticks once a second so the countdown moves without the caller re-fetching the chain. */
function useNow(): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function AuctionView({
  auction,
  auctionErr,
  lotImage,
  data,
  address,
  chainId,
  busy,
  txErr,
  txHash,
  onBid,
  onWithdraw,
  onSettle,
  onClaim,
  onClaimLot,
  dep,
  onOpenToken,
}: {
  auction: AuctionState | null;
  /** A read that failed, rather than an auction that is not there. */
  auctionErr: string | null;
  lotImage: string | null;
  data: SiteData | null;
  address: `0x${string}` | undefined;
  chainId: number;
  busy: string | null;
  txErr: {op: string; text: string} | null;
  txHash: string | null;
  onBid: (cardIds: bigint[], ethBackingWei: bigint) => void;
  onWithdraw: () => void;
  onSettle: () => void;
  onClaim: () => void;
  onClaimLot: () => void;
  dep: Deployment;
  onOpenToken: (id: bigint) => void;
}) {
  const now = useNow();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [ethAmount, setEthAmount] = React.useState("");
  const [asking, setAsking] = React.useState(false);

  if (!auction) {
    return (
      <Section title="AUCTION" last>
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.7, color: C.bodyDim, maxWidth: "60ch"}}>
          {auctionErr ? "The auction could not be read." : "No auction is running."}
        </p>
        {auctionErr && (
          <p style={{margin: "12px 0 0", fontSize: 12, lineHeight: 1.6, color: C.bodyDim, maxWidth: "60ch", opacity: 0.75}}>
            {auctionErr}
          </p>
        )}
      </Section>
    );
  }

  const left = secondsLeft(auction, now);
  const ended = left !== null && left === 0;
  const yours = address && auction.highestBidder.toLowerCase() === address.toLowerCase();
  const isSeller = address && auction.seller.toLowerCase() === address.toLowerCase();

  // Cards the connected wallet holds, offered as bid material.
  const owned: SiteToken[] = (data?.tokens ?? []).filter(
    (t) => address && t.owner.toLowerCase() === address.toLowerCase(),
  );
  const pickedTokens = owned.filter((t) => picked.has(t.id.toString()));
  const cardsWei = pickedTokens.reduce((a, t) => a + t.backing, 0n);

  // The ETH field is entered in ETH and must land on the 0.01 lattice; anything finer is not
  // expressible as cards and the contract would reject it.
  const ethWei = (() => {
    if (!ethAmount.trim()) return 0n;
    const n = Number(ethAmount);
    if (!Number.isFinite(n) || n < 0) return -1n;
    const hundredths = Math.round(n * 100);
    if (Math.abs(n * 100 - hundredths) > 1e-9) return -1n;
    return BigInt(hundredths) * UNIT;
  })();
  const ethInvalid = ethWei < 0n;

  const addedWei = cardsWei + (ethInvalid ? 0n : ethWei);
  const totalUnits = auction.yourUnits + addedWei / UNIT;
  const clears = totalUnits >= auction.minimumUnits;
  const mintFee = ethInvalid ? 0n : ethWei / 100n;

  const toggle = (id: bigint) => {
    const key = id.toString();
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = () => {
    setAsking(false);
    setPicked(new Set());
    setEthAmount("");
    onBid(pickedTokens.map((t) => t.id), ethInvalid ? 0n : ethWei);
  };

  const errLine = (op: string) =>
    txErr && txErr.op === op ? (
      <p style={{margin: "14px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
        {txErr.text}
      </p>
    ) : null;

  return (
    <>
      <Section title="LOT">
        <div style={{display: "flex", flexWrap: "wrap", gap: 40}}>
          {lotImage && <Art src={lotImage} width={340} />}
          <div style={{flex: "1 1 320px", minWidth: 0}}>
            <div style={{fontSize: 40, lineHeight: 1}}>
              {auction.highestBidder === ZERO_ADDRESS
                ? "No bids"
                : `${unitsToEth(auction.highestUnits)} ETH`}
            </div>
            <div style={{marginTop: 10, fontSize: 13, color: C.muted}}>
              {auction.highestBidder === ZERO_ADDRESS
                ? `Reserve ${unitsToEth(auction.reserveUnits)} ETH`
                : `Held by ${short(auction.highestBidder)}`}
            </div>

            <div style={{marginTop: 26, fontSize: 13, lineHeight: 1.8, color: C.bodyDim}}>
              <div>
                {auction.settled
                  ? "Settled."
                  : left === null
                    ? "The clock starts at the first bid."
                    : ended
                      ? "Bidding is closed."
                      : `${formatCountdown(left)} left`}
              </div>
              <div>Next bid: {unitsToEth(auction.minimumUnits)} ETH or more</div>
              <div>
                Seller {short(auction.seller)} · lot #{auction.tokenId.toString()}
              </div>
              <div>
                Collection{" "}
                {lotIsAShape(dep, auction) ? (
                  "Shapes"
                ) : (
                  <a
                    href={`https://evm.now/address/${auction.nft}?chainId=${chainId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{color: "inherit"}}
                  >
                    {short(auction.nft)}
                  </a>
                )}
              </div>
              {!lotIsAShape(dep, auction) && (
                <div style={{color: C.muted}}>
                  The house does not vouch for this collection. Check it before bidding.
                </div>
              )}
            </div>

            {isSettleable(auction, now) && (
              <button
                type="button"
                className="btn-filled"
                onClick={onSettle}
                disabled={!!busy}
                style={{marginTop: 26, padding: "11px 26px"}}
              >
                {busy === "settle" ? "Waiting for confirmation" : "Settle"}
              </button>
            )}
            {errLine("settle")}
          </div>
        </div>
      </Section>

      {!auction.settled && !ended && (
        <Section title="BID" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            A bid is Shapes, not a number. Pick cards you hold, or name an amount of ETH and the
            house mints the cards for you.
          </p>
          <p style={{margin: "0 0 26px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
            Your cards sit in escrow while you lead. Outbid, you pull them back yourself; the
            house never sends anything unasked. Amounts step in 0.01 ETH, the smallest
            denomination.
          </p>

          {owned.length > 0 && (
            <>
              <div style={{fontSize: 10, letterSpacing: "0.14em", color: C.muted, marginBottom: 14}}>
                YOUR SHAPES
              </div>
              <div style={{display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 26}}>
                {owned.map((t) => {
                  const on = picked.has(t.id.toString());
                  return (
                    <button
                      key={t.id.toString()}
                      type="button"
                      className="btn-ghost"
                      onClick={() => toggle(t.id)}
                      style={{width: 84, textAlign: "left"}}
                    >
                      <div style={{outline: on ? `2px solid ${C.ink}` : "none", outlineOffset: 2}}>
                        <Art src={localArt(t.seed, t.backing, t.inkGene)} />
                      </div>
                      <div style={{marginTop: 8, fontSize: 11, color: on ? C.ink : C.muted}}>
                        {DENOMINATIONS[t.di]!.label} ETH
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div style={{fontSize: 10, letterSpacing: "0.14em", color: C.muted, marginBottom: 10}}>
            OR ETH
          </div>
          <input
            value={ethAmount}
            onChange={(e) => setEthAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            style={{
              background: "none",
              border: `1px solid ${ethInvalid ? C.border : C.rule}`,
              color: C.ink,
              font: "inherit",
              fontSize: 15,
              padding: "10px 14px",
              width: 180,
            }}
          />
          {ethInvalid && (
            <div style={{marginTop: 10, fontSize: 12, color: C.muted}}>
              Amounts step in 0.01 ETH.
            </div>
          )}
          {!ethInvalid && ethWei > 0n && (
            <div style={{marginTop: 12, fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
              Mints {breakdown(ethWei).map((b) => `${b.count} × ${DENOMINATIONS[b.di]!.label}`).join(", ")}
              . Costs {formatEther(ethWei + mintFee)} ETH, including the {formatEther(mintFee)} ETH
              mint fee.
            </div>
          )}

          <div style={{marginTop: 26, fontSize: 13, lineHeight: 1.8}}>
            <div>
              This bid: {unitsToEth(totalUnits)} ETH
              {auction.yourUnits > 0n && ` (${unitsToEth(auction.yourUnits)} already escrowed)`}
            </div>
            {!clears && addedWei > 0n && (
              <div style={{color: C.muted}}>
                Needs {unitsToEth(auction.minimumUnits)} ETH to take the lead.
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn-filled"
            onClick={() => setAsking(true)}
            disabled={!!busy || !address || addedWei === 0n || !clears}
            style={{marginTop: 22, padding: "11px 26px"}}
          >
            {busy === "bid" ? "Waiting for confirmation" : "Place bid"}
          </button>
          {errLine("bid")}

          {asking && (
            <Modal title="CONFIRM BID" onCancel={() => setAsking(false)}>
              <p style={{margin: "0 0 14px", fontSize: 14, lineHeight: 1.7, color: C.ink}}>
                Bidding escrows {unitsToEth(addedWei / UNIT)} ETH of Shapes, taking your bid to{" "}
                {unitsToEth(totalUnits)} ETH.
              </p>
              <p style={{margin: "0 0 24px", fontSize: 13, lineHeight: 1.7, color: C.muted}}>
                Your cards stay in escrow while you lead. If you are outbid, you pull them back
                yourself. Winning hands them to the seller and the lot to you.
              </p>
              <div style={{display: "flex", flexWrap: "wrap", gap: 12}}>
                <button
                  type="button"
                  className="btn-filled"
                  onClick={submit}
                  disabled={!!busy}
                  style={{padding: "11px 26px"}}
                >
                  Place bid
                </button>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => setAsking(false)}
                  disabled={!!busy}
                  style={{padding: "11px 26px"}}
                >
                  Cancel
                </button>
              </div>
            </Modal>
          )}
        </Section>
      )}

      {auction.yourCards.length > 0 && (
        <Section title="YOUR ESCROW" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            {yours && !auction.settled
              ? "These are the standing bid. They stay here until someone outbids you."
              : yours
                ? "You won. These go to the seller when they claim them."
                : "Yours to take back."}
          </p>
          <div style={{display: "flex", flexWrap: "wrap", gap: 14}}>
            {auction.yourCards.map((id) => (
              <button
                key={id.toString()}
                type="button"
                className="btn-ghost"
                onClick={() => onOpenToken(id)}
                style={{fontSize: 12, color: C.bodyDim}}
              >
                #{id.toString()}
              </button>
            ))}
          </div>
          {!yours && (
            <>
              <button
                type="button"
                className="btn-outline"
                onClick={onWithdraw}
                disabled={!!busy}
                style={{marginTop: 24, padding: "10px 20px"}}
              >
                {busy === "withdraw" ? "Waiting for confirmation" : "Take them back"}
              </button>
              {errLine("withdraw")}
            </>
          )}
        </Section>
      )}

      {yours && auction.settled && !auction.lotClaimed && (
        <Section title="DELIVERY" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            You won lot #{auction.tokenId.toString()}. Settling recorded the result; this takes
            delivery. It stays claimable, so there is no deadline.
          </p>
          <button
            type="button"
            className="btn-filled"
            onClick={onClaimLot}
            disabled={!!busy}
            style={{padding: "11px 26px"}}
          >
            {busy === "claimLot" ? "Waiting for confirmation" : "Take delivery"}
          </button>
          {errLine("claimLot")}
        </Section>
      )}

      {isSeller && auction.settled && !auction.lotClaimed && auction.highestBidder === ZERO_ADDRESS && (
        <Section title="LOT" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            The auction closed without a bid. Pull the lot back out of the house.
          </p>
          <button
            type="button"
            className="btn-filled"
            onClick={onClaimLot}
            disabled={!!busy}
            style={{padding: "11px 26px"}}
          >
            {busy === "claimLot" ? "Waiting for confirmation" : "Reclaim the lot"}
          </button>
          {errLine("claimLot")}
        </Section>
      )}

      {isSeller && auction.settled && auction.highestBidder !== ZERO_ADDRESS && (
        <Section title="PROCEEDS" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            The winning bid is {unitsToEth(auction.highestUnits)} ETH in Shapes. Hold them as
            objects or redeem them for the ETH.
          </p>
          <button
            type="button"
            className="btn-filled"
            onClick={onClaim}
            disabled={!!busy}
            style={{padding: "11px 26px"}}
          >
            {busy === "claim" ? "Waiting for confirmation" : "Claim the bid"}
          </button>
          {errLine("claim")}
        </Section>
      )}

      <Section title="TERMS" last pad="26px 48px 34px 32px">
        <div style={{fontSize: 13, lineHeight: 1.9, color: C.bodyDim}}>
          <div>Reserve {unitsToEth(auction.reserveUnits)} ETH</div>
          <div>Each bid clears the last by {auction.minIncrementBps / 100}%, at least 0.01 ETH</div>
          <div>
            Runs {Number(auction.duration) / 3600} hours from the first bid
          </div>
          <div>
            A bid in the last {auction.extensionWindow / 60} minutes pushes the end out by the
            same
          </div>
          <div>The house takes no fee</div>
        </div>
        {txHash && (
          <div style={{marginTop: 20, fontSize: 12}}>
            <a href={txUrl(txHash, chainId)} target="_blank" rel="noreferrer">
              View the last transaction
            </a>
          </div>
        )}
      </Section>
    </>
  );
}
