# Charter

What Shapes is, what never changes, and what done means. Everything else lives in the other project docs (see `project/SYSTEM.md` for the map).

## Product

Shapes is an Ethereum primitive: an ERC721 whose every token wraps an exact, fixed amount of ETH. Redeeming a token returns exactly the wei it was minted with. Nine fixed denominations (mainnet ladder: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH). Artwork is fully on-chain generative SVG, a pure function of (seed, denomination), sparser at higher value. One live Shape is the backed owner token, transferable collectible ownership of the contract; it starts as #0, moves through compose, decompose and split, and ends collection ownership permanently when redeemed or burned. `owner()` follows its current holder and grants no administrative authority. On top of the wrap/redeem primitive sits a provenance layer: compose (merge into a survivor, reversible), decompose (LIFO reversal), split (final), sacrifice (burn a 100 ETH apex's backing to 0xdEaD, producing a zero-value Black Shape), plus ink genes and an auction house denominated in Shape cards.

Priority order (from SHAPES_V2_SPEC.md, still binding):
1. Trustworthiness of the ETH backing and redemption system.
2. Composition and provenance as a meaningful collectible system.
3. A primitive simple enough for other contracts to build on.

## Fixed principles

These are constitutional. Changing any of them is a charter amendment, recorded in `project/DECISIONS.md`, not a normal decision.

1. Reserve invariant: `address(this).balance >= redeemableBacking()` at all times. ETH enters only via mint; direct transfers revert.
2. Redemption is exact and unconditional: same wei out as in, no fee, no pool share, no appraisal.
3. The nine denominations are the only representable backing values, stored as an index so off-ladder backing is unrepresentable.
4. No upgradeability, no proxy, no pause, no treasury withdrawal, no emergency escape hatch. The flat `mintFee` (0.001 ETH per mainnet Shape) and `artist` are immutable; the one direct artist attestation cannot be replaced. Admin may redirect only future mint fees; it cannot change the amount or recover funds.
5. Admin powers are bounded to renderer, collection metadata, copy text, explicit positions and market pointers, and the destination of future mint fees. None can touch backing, redemption, token ownership, Shape #0, accrued fees, or ETH already held by Shapes. Presentation, positions and market are independently one-way lockable; admin itself is transferable and renounceable, which freezes every remaining mutable setting and the final fee recipient. Shape #0's holder has no administrative capability.
6. Entropy enters only at mint, from block data, excluding minter identity. Every downstream transformation (compose walk, split child seeds, decompose restore, ink walks) is deterministic from on-chain state. Seed/gene grinding is an accepted residual, not a bug: redemption value never depends on the seed.
7. Origin count is conserved: created only by fresh mints, never fabricated by compose/split/decompose.
8. The TypeScript renderer (`preview/src/canonical/render.ts`) is the specification; `src/ShapeRenderer.sol` is a byte-parity port. All geometry is WAD integer arithmetic. Parity is CI-enforced (fixtures + ParityTest).
9. `Shapes.sol` stays under EIP-170. Any core addition requires both default and testnet size checks. D-36 leaves 214/235 bytes of runtime margin respectively, so further core growth requires explicit byte recovery.
10. The auction house takes no protocol fee (a percentage of a card-lattice amount need not land on the lattice; structurally excluded, per ZERO_AUCTION_DRAFT.md).
11. Artist attribution is permanent and powerless. The deployer remains `artist()` after collectible ownership or admin moves; one release signature may be stored directly in Shapes, but artist status grants no authority or economics.

## Non-goals

- Wrapping ETH in a Shape is not an investment and earns nothing. No yield, lending, or staking of held ETH, ever.
- No royalties (`royaltyInfo` permanently returns zero).
- No global lineage registry as an authoritative singleton; lineage, if any, lives per-work at the write authority, with any global graph as a derived read layer (decision 2026-08, recorded in DECISIONS.md).
- No `seal` mechanism (designed and rejected, ZERO_AUCTION_DRAFT.md; a decision, not a deferral).

## Success definition

Mainnet deployment of the audited system with the correct ladder, immutable values set right the first time, and the intended initial admin, fee recipient and Shape #0 custody. The site survives real traffic without RPC dependence on a single free endpoint, and the repo's docs match reality. The project remains understandable and internally consistent over months; no phase advances past its evidence gate (`project/ROADMAP.md`).
