# Research brief: a market for transferable, powerless status on contracts

You are evaluating whether a new onchain standard should exist, and if so what it should be. This
is a research and design task. The deliverable is a written recommendation, not code. You are
explicitly permitted — encouraged — to conclude that this should not be built, or that it already
exists under another name.

Do not assume a particular project, collection, token or application. Nothing here is about any
specific contract. If you find yourself designing for one, stop and generalise.

## The primitive

Some contracts record a single address as holding a named, transferable status that carries **no
authority**. Call it *title* for now; whether that is the right word is one of the questions below.

Concretely, the minimal form is:

```solidity
address public titleHolder;
uint64  public titleSince;

function transferTitle(address to) external;   // caller must be titleHolder
```

The defining properties, which are what make it unlike anything already standardised:

1. **It is powerless.** The holder cannot pause, mint, withdraw, upgrade, seize, or configure
   anything. It gates no function. It is read by nothing except its own transfer. This is the
   whole point, and it is what separates it from `Ownable.owner()`.
2. **It is a singleton.** There is exactly one per contract. Not a supply of one — a single
   storage slot that cannot be enumerated, batched, or fractionalised without a wrapper.
3. **It is a bearer instrument with no recovery.** Sent to an address that cannot act, it is
   stranded permanently. No admin can retrieve it, deliberately: an authority able to recover it
   is an authority able to take it.
4. **It is push-only in the naive form.** There is no `approve` and no `transferFrom`, so no third
   party can move it. A marketplace can only transact it by taking custody first.

The question is whether there should be a standard interface for this, and a shared market
contract that can trade it for *any* contract implementing that interface.

## The four questions to answer first

Answer these before designing anything. If the answers are unfavourable, say so and stop.

**1. Why doesn't this already exist?**

Absence of a thing is evidence. Find out whether it is absent because nobody thought of it,
because it was tried and failed, because it is already solved under another name, or because there
is no demand. Distinguish those. "Nobody has done it" is the least likely explanation and needs
the most evidence.

**2. Why don't people buy and sell title to contracts today?**

Note that people *do* sell contract ownership — protocol acquisitions, and the darker version
where a sold admin key becomes a rug pull. That market exists precisely because `owner()` carries
power. Does removing the power remove the market with it? Is a powerless status something anyone
pays for, and if so who and why? Look for real evidence of demand (attribution, provenance,
patronage, sponsorship, naming rights, credit) rather than reasoning about whether it *ought* to
be valuable.

**3. Is "title" the right label?**

It carries legal freight — title to property implies ownership and rights this thing does not
grant. Consider and argue between at least: title, deed, patron, steward, custodian, honorific,
credit, attribution, sponsor, keeper, dedicatee. The right word should make a first-time reader
guess the semantics correctly, and should not imply powers the holder does not have. Prefer the
plainest word that is accurate.

**4. What should we be considering that this brief has not raised?**

The most useful part of your answer is likely here.

## The objection you must beat

**Why is this not simply an ERC-721 with a supply of one?**

A 1-of-1 NFT is already a transferable, powerless, marketable status with universal infrastructure:
every marketplace, wallet, indexer and aggregator supports it for free. It has `approve`, so
non-custodial listing works. It has an events model indexers already follow.

If the answer to "why a new standard" is not substantially better than "because a singleton in
storage is slightly cheaper", this proposal collapses and you should say so plainly.

Arguments to test rather than assume:
- A token can be fractionalised, lent, used as collateral, and wrapped. Is that a defect for this
  use, or a feature someone will want anyway?
- A token requires a token contract. Does the status become detached from the thing it is a status
  *of*? Does that matter?
- A singleton cannot be accidentally minted twice, split, or confused with the collection's other
  tokens. Is that worth a standard?
- Does `ownerOf(0)` reading as a status confuse the contract's actual purpose?

Steelman the ERC-721 answer before rejecting it.

## Prior art to actually read, not guess at

- **CryptoPunks' built-in market.** Offers and bids inside the token contract. Note *why* it needs
  no escrow: the market is the token contract, so it can move a punk without permission.
- **ENS.** Name ownership, the registry/registrar split, and the controller/approval model.
- **Harberger tax / patronage art.** "This Artwork Is Always On Sale", partial common ownership.
  Directly relevant: a perpetual, always-purchasable status with a holding cost.
- **ERC-721, ERC-1155**, and the marketplace stack (Seaport, Zora, Blur) — what listing actually
  requires in practice.
- **ERC-4907** (rentable NFTs), **ERC-6551** (token-bound accounts), **ERC-5114** (soulbound badges),
  **ERC-5192** (minimal soulbound). Each solves an adjacent "status attached to a thing" problem.
- **EIP-173** (contract ownership) and OpenZeppelin `Ownable2Step` — the powered sibling.
- Attribution and credit systems outside crypto: art provenance, dedications, naming rights,
  ship registries, patents, academic authorship. What do they get right that onchain misses?

For each, state what it does, why it is or is not this, and what it teaches.

## If it survives: design questions

Only proceed here if the answers above justify it.

**Interface.** What is the minimal interface a contract must implement to be tradeable by a shared
market? How is it discovered (ERC-165)? What events must it emit for indexers? How does a market
verify a contract implements it honestly, and what happens when a contract lies about its own
state — a hostile implementation can report any holder it likes.

**Custody vs approval.** A market can either take custody of the status, or move it with the
holder's approval. Approval is non-custodial: the holder keeps the status while listed, and a bug
in the market cannot strand anyone. It also introduces a second address that can move a bearer
instrument with no recovery, which is a serious footgun on a singleton that cannot be re-minted.
Work through both. Consider revocation, stale listings, and whether approval should expire.

**Market shape.** Fixed-price asks, standing bids, timed auctions, Harberger/always-for-sale, or
several. What denominated in? Consider whether a shared market should be opinionated or a
settlement layer others build on.

**Who can list.** The holder only, or approved operators? What stops a listing being sniped in the
gap between an intent to sell and the status actually becoming transactable?

**Royalties and the original holder.** Should a contract's deployer take a cut of secondary title
sales? Is that enforceable, and should it be?

## Second-order effects — think hard here

This is the part the user cares most about. A standard changes behaviour, and the changes are not
all intended.

- If status becomes liquid, does it stop meaning what it meant? Does a purchasable honorific still
  honour anything?
- Does it let someone buy reputation — acquiring title to a well-regarded contract to launder
  credibility? Is that a feature or an attack?
- Does it create pressure on creators to sell status they would rather keep, simply because a
  market exists and a price is visible?
- Does a visible price become a public valuation of a work, and what does that do to the work?
- Does it invite squatting: deploying contracts purely to sell their titles?
- What does it do to attribution, if the person credited is whoever last paid?
- Phishing surface: approvals on an unrecoverable singleton, and users trained to sign them.
- MEV and front-running around sales and transfers.
- Tax and securities treatment of a purely honorary asset with no cash flow. Do not give legal
  advice; do flag where a lawyer is needed.
- What happens to the status when the underlying contract is abandoned, self-destructed, or
  becomes worthless?

## Adversarial review

Assume the market contract will hold or move valuable, unrecoverable things.

- A contract that lies about who holds its status, or reverts on transfer, or reverts selectively.
- What is the blast radius when one listed contract is hostile? Can it reach anyone who did not
  choose to interact with it? This bound is the property a shared market lives or dies on.
- Reentrancy across the market and the titled contract.
- A holder who is a contract that cannot call the transfer function.
- Griefing: listings that cannot settle, bids that cannot be withdrawn, status that cannot be
  delivered.

## Standardisation

If you recommend a standard, address: what makes an ERC actually get adopted rather than merely
published; what the minimum viable interface is; how it degrades when only partially implemented;
whether it should be one ERC or two (the status interface, and the market separately); and what
existing infrastructure would need to change to support it.

## Deliverable

A written recommendation, in this order:

1. **A verdict in the first paragraph.** Build it, build something different, or do not build it.
   Do not bury this.
2. The answers to the four questions, with evidence.
3. Whether the ERC-721 objection is beaten, and how.
4. If proceeding: the interface, the market design, and the reasoning behind each choice.
5. Second-order effects, including the ones that argue against.
6. What you are uncertain about, and what would resolve it.

Be concrete. Prefer a claim you can defend to a survey of options. Where you are guessing, say you
are guessing. If the honest answer is that a 1-of-1 NFT already does this and the right move is to
use one, that is a complete and valuable answer — say it in the first paragraph and explain why.
