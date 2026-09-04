import {strict as assert} from "node:assert";
import {test} from "node:test";
import {
  getPhase,
  isAuctionActive,
  parseBidEth,
  secondsUntilStart,
  unitsToEth,
  type AuctionState,
} from "./auction";
import {DENOMINATIONS, UNIT} from "../canonical/denominations";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** A loaded auction record with every field defaulted to its "pre-bid, untouched" value; pass
 *  overrides for the fields a test cares about. */
function mockAuction(overrides: Partial<AuctionState> = {}): AuctionState {
  return {
    id: 0n,
    seller: ZERO_ADDR,
    tokenId: 0n,
    endTime: 0n,
    startTime: 0n,
    duration: 86_400n,
    extensionWindow: 300,
    minIncrementBps: 500,
    reserveUnits: 1n,
    highestUnits: 0n,
    highestBidder: ZERO_ADDR,
    highestCards: [],
    settled: false,
    lotClaimed: false,
    minimumUnits: 1n,
    yourUnits: 0n,
    yourCards: [],
    chainNow: 1_000,
    readAt: Date.now(),
    ...overrides,
  };
}

test("unitsToEth renders every denomination on the ladder", () => {
  for (const wei of DENOMINATIONS) {
    const units = wei / UNIT;
    assert.equal(parseBidEth(unitsToEth(units)), wei);
  }
});

test("unitsToEth does not collapse the smallest unit to zero", () => {
  assert.notEqual(unitsToEth(1n), "0");
  assert.equal(parseBidEth(unitsToEth(1n)), UNIT);
});

test("parseBidEth accepts whole units and rejects finer amounts", () => {
  assert.equal(parseBidEth(""), 0n);
  assert.equal(parseBidEth("1"), 10n ** 18n);
  assert.equal(parseBidEth(unitsToEth(3n)), 3n * UNIT);
  assert.equal(parseBidEth("abc"), -1n);
  assert.equal(parseBidEth("-1"), -1n);
  // Half a unit is not expressible as cards.
  const halfUnit = unitsToEth(1n) + "5";
  assert.equal(parseBidEth(halfUnit), -1n);
});

test("isAuctionActive: false while the slot has not resolved to a real auction", () => {
  assert.equal(isAuctionActive("loading"), false);
  assert.equal(isAuctionActive("error"), false);
  assert.equal(isAuctionActive(null), false);
});

test("isAuctionActive: true pre-bid, live, and ended-but-unsettled; false once settled", () => {
  assert.equal(isAuctionActive(mockAuction({endTime: 0n})), true); // pre-bid: open for bids
  assert.equal(
    isAuctionActive(mockAuction({endTime: 1_500n, chainNow: 1_000})),
    true, // live: endTime is ahead of the chain-time anchor read alongside it
  );
  assert.equal(
    isAuctionActive(mockAuction({endTime: 500n, chainNow: 1_000})),
    true, // endTime already behind chainNow: ended, awaiting settlement
  );
  assert.equal(isAuctionActive(mockAuction({endTime: 500n, chainNow: 1_000, settled: true})), false);
});

// SiteApp passes this value into the shared SiteHeader's auctionActive prop, gating its AUCTION
// link on every view including the home view (rendered via renderHome's header argument): no
// jsdom/react-dom is wired into this suite (see wagmi.test.ts's plain node:test pattern) to render
// SiteApp itself and inspect what it passed to SiteHeader.
test("isAuctionActive: the value SiteApp forwards to SiteHeader's AUCTION link", () => {
  assert.equal(isAuctionActive(mockAuction({endTime: 1_500n, chainNow: 1_000})), true); // live
  assert.equal(isAuctionActive(mockAuction({endTime: 500n, chainNow: 1_000, settled: true})), false);
});

test("getPhase: scheduled while startTime is ahead of now, pre-bid once it lands", () => {
  const a = mockAuction({endTime: 0n, startTime: 1_500n});
  assert.equal(getPhase(a, 1_000), "scheduled");
  // startTime == now is pre-bid, not scheduled: bidding is open the instant it's reached.
  assert.equal(getPhase(mockAuction({endTime: 0n, startTime: 1_000n}), 1_000), "pre-bid");
  assert.equal(getPhase(mockAuction({endTime: 0n, startTime: 500n}), 1_000), "pre-bid");
});

test("getPhase: settled overrides a startTime still in the future", () => {
  assert.equal(getPhase(mockAuction({endTime: 500n, startTime: 2_000n, settled: true}), 1_000), "settled");
});

test("secondsUntilStart: floored seconds while scheduled, null otherwise", () => {
  assert.equal(secondsUntilStart(mockAuction({endTime: 0n, startTime: 1_500n}), 1_000.4), 499);
  assert.equal(secondsUntilStart(mockAuction({endTime: 0n, startTime: 1_000n}), 1_000), null); // pre-bid
  assert.equal(secondsUntilStart(mockAuction({endTime: 1_500n, startTime: 2_000n}), 1_000), null); // live
  assert.equal(
    secondsUntilStart(mockAuction({endTime: 500n, startTime: 2_000n, settled: true}), 1_000),
    null,
  );
});

test("isAuctionActive: true while scheduled", () => {
  assert.equal(isAuctionActive(mockAuction({endTime: 0n, startTime: 1_500n, chainNow: 1_000})), true);
});
