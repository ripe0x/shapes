import {strict as assert} from "node:assert";
import {test} from "node:test";
import {isAuctionActive, parseBidEth, unitsToEth, type AuctionState} from "./auction";
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
    duration: 86_400n,
    extensionWindow: 300,
    minIncrementBps: 500,
    reserveUnits: 1n,
    highestUnits: 0n,
    highestBidder: ZERO_ADDR,
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

// SiteApp passes this same isAuctionActive(auction) value both to gate the header's own AUCTION
// link and as renderHome's third argument (the home nav's Auction link), so this single pure
// check covers both call sites: no jsdom/react-dom is wired into this suite (see wagmi.test.ts's
// plain node:test pattern) to render SiteApp itself and inspect what it passed to renderHome.
test("isAuctionActive: the value SiteApp forwards to renderHome for the home nav's Auction link", () => {
  assert.equal(isAuctionActive(mockAuction({endTime: 1_500n, chainNow: 1_000})), true); // live
  assert.equal(isAuctionActive(mockAuction({endTime: 500n, chainNow: 1_000, settled: true})), false);
});
