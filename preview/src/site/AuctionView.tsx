import React from "react";
import {formatEther, type PublicClient} from "viem";
import {useBalance} from "wagmi";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {C, label} from "./theme";
import {Section, Modal, Art, txUrl, TxStage, txStageLabel, type PendingTx} from "./ui";
import {localArt} from "./art";
import {useDisplayName} from "./useDisplayName";
import {
  breakdown,
  chainNowFor,
  formatCountdown,
  formatRelativeTime,
  getPhase,
  loadBidHistory,
  secondsLeft,
  unitsToEth,
  parseBidEth,
  UNIT,
  type AuctionSlot,
  type BidHistoryEntry,
} from "./auction";
import type {SiteData, SiteToken} from "./data";
import {shapeTitle} from "./shapeTitle";

/** Font size for the token name, the panel's dominant element. */
const HERO_SIZE = 40;

/** Font size for the countdown and the current-bid amount, stacked at equal size. */
const PRICE_SIZE = 22;

/** Escrowed cards drawn beside the current bid before the rest collapse to a "+N" count. A
 *  card-mode bid can escrow any number of cards, so the hero row needs a bound. */
const HERO_CARD_LIMIT = 5;

/** Escrowed cards ordered for display: largest denomination first, then by id. Cards missing from
 *  the live set (data not loaded yet) sort last. */
function orderCards(ids: bigint[], data: SiteData | null): {id: bigint; token: SiteToken | undefined}[] {
  return ids
    .map((id) => ({id, token: data?.tokens.find((t) => t.id === id)}))
    .sort((a, b) => {
      const da = a.token?.di ?? -1;
      const db = b.token?.di ?? -1;
      if (da !== db) return db - da;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Top padding of the hero row, in px. Reused as the target bottom margin below the artwork so
 *  the image sits with matching space above and below within the viewport. */
const TOP_MARGIN = 32;

/** Ticks once a second so the countdown moves without the caller re-fetching the chain. Anchored
 *  to the chain's own clock (via `chainNowFor`) rather than `Date.now()`, which can be far from
 *  the chain's block timestamp on a dev chain whose clock has been advanced. Falls back to
 *  wall-clock time while no auction has loaded yet; that value goes unused until it has. */
function useNow(auction: AuctionSlot): number {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return typeof auction === "object" && auction !== null ? chainNowFor(auction) : Math.floor(Date.now() / 1000);
}

/** Max height available for the hero artwork so it renders fully within the viewport: the window
 *  height minus the measured header and minus the top margin twice, once for the gap already
 *  above the art and once matched below it. Re-measured on resize since the header height and
 *  viewport size can both change. */
function useArtMaxHeight(): number | null {
  const [maxHeight, setMaxHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    const measure = () => {
      const headerHeight = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      setMaxHeight(window.innerHeight - headerHeight - 2 * TOP_MARGIN);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return maxHeight;
}

/** "24 hours", "10 minutes", "90 seconds": the largest unit that divides the duration evenly. */
function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function AuctionView({
  auction,
  lotImage,
  data,
  dep,
  publicClient,
  address,
  busy,
  pendingTx,
  txErr,
  txHash,
  onBid,
  onWithdraw,
  onRetry,
  onSettle,
  onClaim,
  onClaimLot,
  onOpenToken,
}: {
  /** "loading" before the first chain read resolves, null once resolved with no live auction. */
  auction: AuctionSlot;
  lotImage: string | null;
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  busy: string | null;
  pendingTx: PendingTx | null;
  txErr: {op: string; text: string} | null;
  txHash: string | null;
  onBid: (cardIds: bigint[], ethBackingWei: bigint) => void;
  onWithdraw: () => void;
  /** Re-reads the auction after a failed load. */
  onRetry: () => void;
  onSettle: () => void;
  onClaim: () => void;
  /** Winner: claimLot, which delivers the token. */
  onClaimLot: () => void;
  onOpenToken: (id: bigint) => void;
}) {
  const now = useNow(auction);
  const artMaxHeight = useArtMaxHeight();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [ethAmount, setEthAmount] = React.useState("");
  const [asking, setAsking] = React.useState(false);
  // The confirm modal stays open while the bid is in flight so its stage line and the wallet
  // prompt are seen together. It closes when the op settles; the picks are cleared only on
  // success so a failed bid can be retried as it was.
  const bidding = React.useRef(false);
  React.useEffect(() => {
    if (busy === "bid") {
      bidding.current = true;
      return;
    }
    if (busy === null && bidding.current) {
      bidding.current = false;
      setAsking(false);
      if (!(txErr && txErr.op === "bid")) {
        setPicked(new Set());
        setEthAmount("");
      }
    }
  }, [busy, txErr]);

  // Which input is live: the ETH field mints its own cards, the card picker spends cards the
  // wallet already holds. Mutually exclusive — a bid is whichever mode is active, plus whatever
  // is already escrowed from earlier bids.
  const [mode, setMode] = React.useState<"eth" | "cards">("eth");
  const {data: balance} = useBalance({
    address,
    chainId: dep.chainId,
    query: {enabled: !!address},
  });

  // The standing bidder's identity, resolved before any early return so the hook order stays
  // fixed regardless of the auction slot's state.
  const highestBidder = typeof auction === "object" && auction !== null ? auction.highestBidder : undefined;
  const bidderIdentity = useDisplayName(highestBidder);

  const auctionId = typeof auction === "object" && auction !== null ? auction.id : null;
  // "loading" until the first read resolves, null once the indexer has declined to supply a
  // history (none configured, unreachable, or behind its freshness guard), otherwise the entries.
  const [bidHistory, setBidHistory] = React.useState<BidHistoryEntry[] | null | "loading">("loading");
  React.useEffect(() => {
    if (!publicClient || auctionId === null) return;
    let cancelled = false;
    setBidHistory("loading");
    void loadBidHistory(publicClient, dep, auctionId).then((entries) => {
      if (!cancelled) setBidHistory(entries);
    });
    return () => {
      cancelled = true;
    };
    // txHash re-triggers the load after any confirmed auction transaction.
  }, [publicClient, dep, auctionId, txHash]);

  if (auction === "error") {
    return (
      <Section title="AUCTION" last>
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.7, color: C.bodyDim, maxWidth: "60ch"}}>
          Could not read the auction.
        </p>
        <button type="button" className="btn-outline" onClick={onRetry} style={{marginTop: 18, padding: "10px 20px"}}>
          Try again
        </button>
      </Section>
    );
  }

  if (auction === "loading") {
    return (
      <Section title="AUCTION" last>
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.7, color: C.bodyDim, maxWidth: "60ch"}}>
          Reading the chain…
        </p>
      </Section>
    );
  }

  if (!auction) {
    return (
      <Section title="AUCTION" last>
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.7, color: C.bodyDim, maxWidth: "60ch"}}>
          No auction is running.
        </p>
      </Section>
    );
  }

  const phase = getPhase(auction, now);
  const left = secondsLeft(auction, now);
  const yours = address && auction.highestBidder.toLowerCase() === address.toLowerCase();
  const isSeller = address && auction.seller.toLowerCase() === address.toLowerCase();
  const isWinner = address && auction.highestBidder.toLowerCase() === address.toLowerCase();
  const nearExtension = phase === "live" && left !== null && left <= auction.extensionWindow;

  // The lot's own name and denomination, looked up by the lot's tokenId (auction.tokenId), not
  // the auction's own id (auction.id) — those are unrelated numbers. Looked up from the
  // already-loaded token list (no extra chain read); absent if the token isn't in the live set
  // for some reason, in which case the name falls back to the tokenId directly.
  const lotToken = data?.tokens.find((t) => t.id === auction.tokenId);
  const lotDenomLabel = lotToken ? DENOMINATIONS[lotToken.di]!.label : null;
  const lotIsOwnerToken = data?.ownerToken != null && data.ownerToken === auction.tokenId;
  const tokenName = lotToken?.meta.name || shapeTitle(auction.tokenId, lotIsOwnerToken);

  // The standing bid as cards, shown beside its amount.
  const heroCards = orderCards(auction.highestCards, data);

  // Cards the connected wallet holds, offered as bid material.
  const owned: SiteToken[] = (data?.tokens ?? []).filter(
    (t) => address && t.owner.toLowerCase() === address.toLowerCase(),
  );
  const pickedTokens = owned.filter((t) => picked.has(t.id.toString()));
  const cardsWei = pickedTokens.reduce((a, t) => a + t.backing, 0n);

  // The ETH field is entered in ETH and must be a whole number of units; anything finer is not
  // expressible as cards and the contract would reject it.
  const ethWei = parseBidEth(ethAmount);
  const ethInvalid = ethWei < 0n;

  // Only the active mode contributes to the bid; the other input's value, if any, is inert.
  const addedWei = mode === "eth" ? (ethInvalid ? 0n : ethWei) : cardsWei;
  const totalUnits = auction.yourUnits + addedWei / UNIT;
  const clears = totalUnits >= auction.minimumUnits;
  const mintFee = mode === "eth" && !ethInvalid
    ? breakdown(ethWei).reduce(
        (sum, item) => sum + BigInt(item.count) * (data?.fees[item.di] ?? 0n),
        0n,
      )
    : 0n;
  // A bid worth stating: something was actually entered or picked, and it would take the lead.
  // The submit button stays disabled and unlabeled with an amount until both hold.
  const hasValidBid = addedWei > 0n && clears;

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
    const cardIds = mode === "cards" ? pickedTokens.map((t) => t.id) : [];
    const backingWei = mode === "eth" && !ethInvalid ? ethWei : 0n;
    onBid(cardIds, backingWei);
  };

  const errLine = (op: string) =>
    txErr && txErr.op === op ? (
      <p style={{margin: "14px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
        {txErr.text}
      </p>
    ) : null;

  return (
    <>
      {/* Hero row: no Section label gutter here (per the layout brief) so the artwork starts at
          the page's own left padding and fills the full 2/3; the bid panel takes the other 1/3.
          Grid ratio and the narrow-screen stack are defined in site.html (.auction-hero).

          The row container itself carries no padding: its box is exactly the space between the
          header's rule above and this row's own border-bottom below, so the panel's border-left
          (drawn at the edge of its box, outside any padding) touches both with no gap. Each
          column supplies its own padding instead, reproducing the same visual inset for its
          content that a shared container padding would have given. */}
      <div className="auction-hero" style={{borderBottom: `1px solid ${C.rule}`}}>
        <div
          className="auction-hero-art"
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            // Top and bottom padding both equal TOP_MARGIN (not the panel's 36): the artwork's
            // own margins are symmetric top-to-bottom by requirement, independent of the
            // panel's own bottom inset before its section rule. Left padding is set by
            // .auction-hero-art in site.html/globals.css so a mobile rule can shrink it.
            paddingTop: TOP_MARGIN,
            paddingBottom: TOP_MARGIN,
            ...(artMaxHeight != null ? {height: artMaxHeight + 2 * TOP_MARGIN} : null),
          }}
        >
          <div
            style={{
              width: "100%",
              aspectRatio: "250 / 350",
              backgroundColor: C.art,
              ...(artMaxHeight != null
                ? {maxHeight: artMaxHeight, maxWidth: (artMaxHeight * 250) / 350}
                : null),
            }}
          >
            {lotImage && (
              <img
                src={lotImage}
                alt=""
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  animation: "artin .35s ease both",
                }}
              />
            )}
          </div>
        </div>

        <div
          className="auction-hero-panel"
          style={{
            borderLeft: `1px solid ${C.rule}`,
            // Right/bottom/left padding is set by .auction-hero-panel in site.html/globals.css
            // so a mobile rule can shrink it; top padding tracks TOP_MARGIN, so it stays here.
            paddingTop: TOP_MARGIN,
            display: "flex",
            flexDirection: "column",
            gap: 22,
            minWidth: 0,
          }}
        >
          <div>
            <div style={{fontSize: HERO_SIZE, lineHeight: 1.05}}>{tokenName}</div>
            {lotDenomLabel && (
              <div style={{marginTop: 8, fontSize: 12, color: C.muted}}>{lotDenomLabel} ETH Shape</div>
            )}
            {lotToken?.meta.description && (
              <p style={{margin: "14px 0 0", maxWidth: "48ch", fontSize: 13, lineHeight: 1.7, color: C.bodyDim}}>
                {lotToken.meta.description}
              </p>
            )}
          </div>

          {phase === "live" && left !== null && (
            <div>
              <div style={label}>ENDS IN</div>
              <div style={{fontSize: PRICE_SIZE, lineHeight: 1, marginTop: 6, whiteSpace: "nowrap"}}>
                {formatCountdown(left)}
              </div>
            </div>
          )}

          {/* The bid block, then its cards across the rest of the row, wrapping as needed. */}
          <div style={{display: "flex"}}>
            <div style={{flex: "0 0 auto"}}>
              <div style={label}>
                {phase === "pre-bid" ? "RESERVE" : phase === "live" ? "CURRENT BID" : "FINAL BID"}
              </div>
              <div style={{fontSize: PRICE_SIZE, lineHeight: 1, marginTop: 6, whiteSpace: "nowrap"}}>
                {phase === "pre-bid" ? unitsToEth(auction.reserveUnits) : unitsToEth(auction.highestUnits)}{" "}
                <span style={{fontSize: 12, color: C.muted}}>ETH</span>
              </div>
              {phase !== "pre-bid" && (
                <div style={{marginTop: 8, fontSize: 11, color: C.muted, overflowWrap: "anywhere"}}>
                  {phase === "live" ? bidderIdentity : `Won by ${bidderIdentity}`}
                </div>
              )}
            </div>
            {heroCards.length > 0 && (
              <div style={{flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 6, marginLeft: 16}}>
                {heroCards.slice(0, HERO_CARD_LIMIT).map((c) => (
                  <CardThumb key={c.id.toString()} id={c.id} token={c.token} size={44} onClick={() => onOpenToken(c.id)} />
                ))}
                {heroCards.length > HERO_CARD_LIMIT && (
                  <div style={{alignSelf: "center", fontSize: 11, color: C.muted, whiteSpace: "nowrap"}}>
                    +{heroCards.length - HERO_CARD_LIMIT}
                  </div>
                )}
              </div>
            )}
          </div>

          {(phase === "pre-bid" || (phase === "live" && nearExtension)) && (
            <div style={{fontSize: 12, lineHeight: 1.7, color: C.bodyDim}}>
              {phase === "pre-bid" && <div>The clock starts at the first bid.</div>}
              {phase === "live" && nearExtension && (
                <div>A bid now pushes the end out by {auction.extensionWindow / 60} more minutes.</div>
              )}
            </div>
          )}

          {phase === "ended-unsettled" && (
            <div>
              <button
                type="button"
                className="btn-filled"
                onClick={onSettle}
                disabled={!!busy}
                style={{width: "100%", padding: "13px 20px"}}
              >
                {txStageLabel("settle", "Settle", busy, pendingTx)}
              </button>
              {errLine("settle")}
            </div>
          )}

          {(phase === "pre-bid" || phase === "live") && (
            <div style={{display: "flex", flexDirection: "column", gap: 14}}>
              {mode === "eth" ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      border: `1px solid ${ethInvalid ? C.border : C.rule}`,
                    }}
                  >
                    <input
                      value={ethAmount}
                      onChange={(e) => setEthAmount(e.target.value)}
                      placeholder={`${unitsToEth(auction.minimumUnits)} or more`}
                      inputMode="decimal"
                      style={{
                        flex: "1 1 auto",
                        minWidth: 0,
                        background: "none",
                        border: "none",
                        color: C.ink,
                        font: "inherit",
                        fontSize: 15,
                        padding: "12px 14px",
                      }}
                    />
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: "0 14px",
                        fontSize: 11,
                        letterSpacing: "0.1em",
                        color: C.muted,
                        borderLeft: `1px solid ${C.rule}`,
                      }}
                    >
                      ETH
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      color: C.muted,
                    }}
                  >
                    <span>MINIMUM BID: {unitsToEth(auction.minimumUnits)} ETH</span>
                    {address && balance && (
                      <span>BALANCE: {Number(formatEther(balance.value)).toFixed(3)} ETH</span>
                    )}
                  </div>
                  {ethInvalid && (
                    <div style={{marginTop: 8, fontSize: 11, color: C.muted}}>
                      Amounts step in {unitsToEth(1n)} ETH.
                    </div>
                  )}
                  {!ethInvalid && ethWei > 0n && (
                    <div style={{marginTop: 10, fontSize: 11, lineHeight: 1.6, color: C.muted}}>
                      Mints {breakdown(ethWei).map((b) => `${b.count} × ${DENOMINATIONS[b.di]!.label}`).join(", ")}
                      . Costs {formatEther(ethWei + mintFee)} ETH, including the {formatEther(mintFee)} ETH
                      mint fee.
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{fontSize: 10, letterSpacing: "0.14em", color: C.muted, marginBottom: 12}}>
                    YOUR SHAPES
                  </div>
                  {owned.length === 0 ? (
                    <div style={{fontSize: 12, color: C.muted}}>This wallet holds no Shapes.</div>
                  ) : (
                    <div style={{display: "flex", flexWrap: "wrap", gap: 12}}>
                      {owned.map((t) => (
                        <CardThumb
                          key={t.id.toString()}
                          id={t.id}
                          token={t}
                          size={72}
                          caption={`#${t.id.toString()} · ${DENOMINATIONS[t.di]!.label} ETH`}
                          selected={picked.has(t.id.toString())}
                          onClick={() => toggle(t.id)}
                        />
                      ))}
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: 12,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      color: C.muted,
                    }}
                  >
                    <span>MINIMUM BID: {unitsToEth(auction.minimumUnits)} ETH</span>
                    {address && balance && (
                      <span>BALANCE: {Number(formatEther(balance.value)).toFixed(3)} ETH</span>
                    )}
                  </div>
                </div>
              )}

              <button
                type="button"
                className="btn-ghost"
                onClick={() => setMode((m) => (m === "eth" ? "cards" : "eth"))}
                style={{
                  alignSelf: "flex-start",
                  fontSize: 11,
                  color: C.muted,
                  textDecoration: "underline",
                  textUnderlineOffset: 3,
                }}
              >
                {mode === "eth" ? "or bid with cards you hold" : "bid with ETH instead"}
              </button>

              {!clears && addedWei > 0n && (
                <div style={{fontSize: 12, lineHeight: 1.7, color: C.muted}}>
                  Needs {unitsToEth(auction.minimumUnits)} ETH to take the lead.
                </div>
              )}

              <button
                type="button"
                className="btn-filled"
                onClick={() => setAsking(true)}
                disabled={!!busy || !address || !hasValidBid}
                style={{width: "100%", padding: "13px 20px"}}
              >
                {txStageLabel(
                  "bid",
                  hasValidBid ? `Place bid worth ${unitsToEth(totalUnits)} ETH` : "Place bid",
                  busy,
                  pendingTx,
                )}
              </button>
              <TxStage op="bid" busy={busy} pendingTx={pendingTx} chainId={dep.chainId} />
              {txHash && busy === null && (
                <div style={{marginTop: 10, fontSize: 11, color: C.muted}}>
                  Transaction confirmed ·{" "}
                  <a href={txUrl(txHash, dep.chainId)} target="_blank" rel="noreferrer" style={{color: C.muted}}>
                    View transaction
                  </a>
                </div>
              )}
              {errLine("bid")}

              <p style={{margin: 0, fontSize: 11, lineHeight: 1.7, color: C.bodyDim}}>
                A bid is Shapes, not a number. Pick cards you hold, or name an amount of ETH and
                the house mints the cards for you. Your cards sit in escrow while you lead.
                Outbid, you pull them back yourself; the house never sends anything unasked.
                Amounts step in {unitsToEth(1n)} ETH, the smallest denomination.
              </p>

              {asking && (
                <Modal title="CONFIRM BID" onCancel={() => setAsking(false)}>
                  <div style={{fontSize: 13, lineHeight: 1.8, color: C.ink}}>
                    {mode === "eth" && ethWei > 0n && (
                      <div>
                        Mints {breakdown(ethWei).map((b) => `${b.count} × ${DENOMINATIONS[b.di]!.label}`).join(", ")}{" "}
                        ETH Shapes. Costs {formatEther(ethWei + mintFee)} ETH, including the{" "}
                        {formatEther(mintFee)} ETH mint fee.
                      </div>
                    )}
                    {mode === "cards" && pickedTokens.length > 0 && (
                      <div>
                        Bidding with {pickedTokens.length} Shape{pickedTokens.length === 1 ? "" : "s"}:{" "}
                        {pickedTokens
                          .map((t) => `#${t.id.toString()} (${DENOMINATIONS[t.di]!.label} ETH)`)
                          .join(", ")}
                        .
                      </div>
                    )}
                    <div style={{marginTop: 12}}>
                      {auction.yourUnits > 0n
                        ? `${unitsToEth(auction.yourUnits)} ETH already escrowed + ${unitsToEth(
                            addedWei / UNIT,
                          )} ETH new = ${unitsToEth(totalUnits)} ETH total bid.`
                        : `${unitsToEth(totalUnits)} ETH total bid.`}
                    </div>
                  </div>
                  <p style={{margin: "18px 0 24px", fontSize: 13, lineHeight: 1.7, color: C.muted}}>
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
                      {txStageLabel("bid", `Place bid worth ${unitsToEth(totalUnits)} ETH`, busy, pendingTx)}
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
                  <TxStage op="bid" busy={busy} pendingTx={pendingTx} chainId={dep.chainId} />
                </Modal>
              )}
            </div>
          )}
        </div>
      </div>

      {bidHistory !== null && (
        <Section title="BID HISTORY" pad="16px 48px 24px 32px">
          {bidHistory === "loading" ? (
            <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>Reading bids…</div>
          ) : bidHistory.length === 0 ? (
            <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>No bids yet.</div>
          ) : (
            bidHistory.map((entry) => (
              <BidHistoryRow
                key={entry.key}
                entry={entry}
                chainId={dep.chainId}
                data={data}
                now={now}
                onOpenToken={onOpenToken}
              />
            ))
          )}
        </Section>
      )}

      {/* An outbid bidder's cards, with the withdrawal. The leader's cards are the standing bid,
          already drawn beside its amount in the hero row. */}
      {auction.yourCards.length > 0 && !yours && (
        <Section title="YOUR ESCROW" pad="26px 48px 36px 32px">
          <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
            Yours to take back.
          </p>
          <div style={{display: "flex", flexWrap: "wrap", gap: 14}}>
            {orderCards(auction.yourCards, data).map((c) => (
              <CardThumb
                key={c.id.toString()}
                id={c.id}
                token={c.token}
                size={72}
                caption={`#${c.id.toString()}${c.token ? ` · ${DENOMINATIONS[c.token.di]!.label} ETH` : ""}`}
                onClick={() => onOpenToken(c.id)}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn-outline"
            onClick={onWithdraw}
            disabled={!!busy}
            style={{marginTop: 24, padding: "10px 20px"}}
          >
            {txStageLabel("withdraw", "Take them back", busy, pendingTx)}
          </button>
          {errLine("withdraw")}
        </Section>
      )}

      {auction.settled && (
        <Section title="LOT" pad="26px 48px 36px 32px">
          {auction.lotClaimed ? (
            <p style={{margin: 0, fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
              {tokenName} was delivered to {bidderIdentity}.
            </p>
          ) : isWinner ? (
            <>
              <p style={{margin: "0 0 22px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
                {tokenName} is yours. Claim it to take delivery.
              </p>
              <button
                type="button"
                className="btn-filled"
                onClick={onClaimLot}
                disabled={!!busy}
                style={{padding: "11px 26px"}}
              >
                {txStageLabel("claimLot", `Claim ${tokenName}`, busy, pendingTx)}
              </button>
              <TxStage op="claimLot" busy={busy} pendingTx={pendingTx} chainId={dep.chainId} />
              {errLine("claimLot")}
            </>
          ) : (
            <p style={{margin: 0, fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
              Awaiting delivery to {bidderIdentity}.
            </p>
          )}
        </Section>
      )}

      {isSeller && auction.settled && (
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
            {txStageLabel("claim", "Claim the bid", busy, pendingTx)}
          </button>
          {errLine("claim")}
        </Section>
      )}

      <Section title="TERMS" last pad="26px 48px 34px 32px">
        <div style={{fontSize: 13, lineHeight: 1.9, color: C.bodyDim}}>
          <div>Reserve {unitsToEth(auction.reserveUnits)} ETH</div>
          <div>Each bid clears the last by {auction.minIncrementBps / 100}%, at least {unitsToEth(1n)} ETH</div>
          <div>
            Runs {formatDuration(Number(auction.duration))} from the first bid
          </div>
          <div>
            A bid in the last {auction.extensionWindow / 60} minutes pushes the end out by the
            same
          </div>
          <div>The house takes no fee</div>
        </div>
      </Section>
    </>
  );
}

/** One escrowed card as a clickable thumbnail. Renders the artwork from the live token when the
 *  card is still live, else an id-only chip since its seed is no longer available to draw. */
function CardThumb({
  id,
  token,
  size,
  caption,
  selected = false,
  onClick,
}: {
  id: bigint;
  token: SiteToken | undefined;
  size: number;
  /** Text under the thumbnail. Omitted for the compact hero row, where the id and denomination
   *  ride on the tooltip. */
  caption?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  const title = `#${id.toString()}${token ? ` · ${DENOMINATIONS[token.di]!.label} ETH` : ""}`;
  return (
    <button type="button" className="btn-ghost" onClick={onClick} title={title} style={{width: size, textAlign: "left"}}>
      <div style={{outline: selected ? `2px solid ${C.ink}` : "none", outlineOffset: 2}}>
        {token ? (
          <Art src={localArt(token.seed, token.backing, token.inkGene)} />
        ) : (
          <div
            style={{
              width: "100%",
              aspectRatio: "250 / 350",
              backgroundColor: C.art,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              color: C.muted,
            }}
          >
            #{id.toString()}
          </div>
        )}
      </div>
      {caption && (
        <div style={{marginTop: size > 40 ? 6 : 4, fontSize: size > 40 ? 10 : 9, color: selected ? C.ink : C.muted}}>
          {caption}
        </div>
      )}
    </button>
  );
}

/** One bid history row: the bidder, by name where they have one, the bidder's running total
 *  after this bid,
 *  thumbnails (each labeled with its denomination) of the cards this bid's transaction moved
 *  into escrow, and the time it landed, relative to now and linking to the transaction. */
function BidHistoryRow({
  entry,
  chainId,
  data,
  now,
  onOpenToken,
}: {
  entry: BidHistoryEntry;
  chainId: number;
  data: SiteData | null;
  now: number;
  onOpenToken: (id: bigint) => void;
}) {
  const identity = useDisplayName(entry.bidder);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px 24px",
        padding: "14px 0",
        borderBottom: `1px solid ${C.ruleInner}`,
        fontSize: 13,
      }}
    >
      <div style={{minWidth: 150, overflowWrap: "anywhere"}}>{identity}</div>
      <div style={{minWidth: 90}}>{unitsToEth(entry.totalUnits)} ETH</div>
      <div style={{flex: "1 1 160px", display: "flex", flexWrap: "wrap", gap: 12}}>
        {entry.cards.length === 0 ? (
          <span style={{fontSize: 12, color: C.muted}}>—</span>
        ) : (
          // The denomination label comes from the bid history entry itself, resolved at load
          // time, so it still shows for a card since composed, split, or redeemed.
          entry.cards.map((c) => (
            <CardThumb
              key={c.id.toString()}
              id={c.id}
              token={data?.tokens.find((t) => t.id === c.id)}
              size={36}
              caption={c.di >= 0 ? `${DENOMINATIONS[c.di]!.label} ETH` : "—"}
              onClick={() => onOpenToken(c.id)}
            />
          ))
        )}
      </div>
      <a
        href={txUrl(entry.tx, chainId)}
        target="_blank"
        rel="noreferrer"
        title={entry.timestamp > 0 ? new Date(entry.timestamp * 1000).toISOString() : undefined}
        style={{marginLeft: "auto", fontSize: 12, color: C.muted, whiteSpace: "nowrap"}}
      >
        {formatRelativeTime(entry.timestamp, now)}
      </a>
    </div>
  );
}
