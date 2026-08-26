# Charter

What Shapes is, what never changes, and what done means. Everything else lives in the other project docs (see `project/SYSTEM.md` for the map).

## Product

Shapes is an Ethereum primitive: an ERC721 whose every token wraps an exact, fixed amount of ETH. Redeeming a token returns exactly the wei it was minted with. Nine fixed denominations (mainnet ladder: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH). Artwork is fully on-chain generative SVG, a pure function of (seed, denomination), sparser at higher value. Backed Shape #0 is the transferable collectible title to the contract; `titleHolder()` follows it and grants no administrative authority. On top of the wrap/redeem primitive sits a provenance layer: compose (merge into a survivor, reversible), decompose (LIFO reversal), split (final), sacrifice (burn a 100 ETH apex's backing to 0xdEaD, producing a zero-value Black Shape), plus ink genes and an auction house denominated in Shape cards.

Priority order (from SHAPES_V2_SPEC.md, still binding):
1. Trustworthiness of the ETH backing and redemption system.
2. Composition and provenance as a meaningful collectible system.
3. A primitive simple enough for other contracts to build on.

## Fixed principles

These are constitutional. Changing any of them is a charter amendment, recorded in `project/DECISIONS.md`, not a normal decision.

1. Reserve invariant: `address(this).balance >= redeemableBacking()` at all times. ETH enters only via mint; direct transfers revert.
2. Redemption is exact and unconditional: same wei out as in, no fee, no pool share, no appraisal.
3. The nine denominations are the only representable backing values, stored as an index so off-ladder backing is unrepresentable.
4. No upgradeability, no proxy, no pause, no treasury withdrawal, no emergency escape hatch. `feeBps` (100 = 1%) and `feeRecipient` are immutable.
5. Admin powers are value-inert: renderer, collection metadata, copy text, and position resolver. None can touch ETH, backing, redemption, token ownership, or the Shape #0 title. Presentation pointers and the resolver are independently one-way lockable; admin itself is transferable and renounceable. Shape #0's title holder has no administrative capability.
6. Entropy enters only at mint, from block data, excluding minter identity. Every downstream transformation (compose walk, split child seeds, decompose restore, ink walks) is deterministic from on-chain state. Seed/gene grinding is an accepted residual, not a bug: redemption value never depends on the seed.
7. Origin count is conserved: created only by fresh mints, never fabricated by compose/split/decompose.
8. The TypeScript renderer (`preview/src/canonical/render.ts`) is the specification; `src/ShapeRenderer.sol` is a byte-parity port. All geometry is WAD integer arithmetic. Parity is CI-enforced (fixtures + ParityTest).
9. `Shapes.sol` stays under EIP-170. Any core addition requires a `forge build --sizes` check; the adopted PR #2 candidate has a 451-byte runtime margin.
10. The auction house takes no protocol fee (a percentage of a card-lattice amount need not land on the lattice; structurally excluded, per ZERO_AUCTION_DRAFT.md).

## Non-goals

- Wrapping ETH in a Shape is not an investment and earns nothing. No yield, lending, or staking of held ETH, ever.
- No royalties (`royaltyInfo` permanently returns zero).
- No global lineage registry as an authoritative singleton; lineage, if any, lives per-work at the write authority, with any global graph as a derived read layer (decision 2026-08, recorded in DECISIONS.md).
- No `seal` mechanism (designed and rejected, ZERO_AUCTION_DRAFT.md; a decision, not a deferral).

## Success definition

Mainnet deployment of the audited system with the correct ladder, immutables set right the first time (they cannot be corrected), a site that survives real traffic without RPC dependence on a single free endpoint, and a repo whose docs match its reality. The project remains understandable and internally consistent over months; no phase advances past its evidence gate (`project/ROADMAP.md`).
