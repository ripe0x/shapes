/** Fact rows shared by the mint screen and the how-it-works screen. Copy is final, from the handoff. */

export interface Fact {
  k: string;
  v: string;
}

export const FACTS: Fact[] = [
  {
    k: "FEE",
    v: "1% of the backing, paid on top of it, once at mint. A 1 ETH Shape costs 1 ETH + 0.01 ETH fee = 1.01 ETH total. There is no burn fee and no transfer fee.",
  },
  {
    k: "REDEMPTION",
    v: "The current owner burns the Shape and receives its exact backing. All or nothing. There is no partial redemption and no way to add ETH to an existing Shape.",
  },
  {
    k: "THE RESERVE",
    v: "The contract holds the ETH. It does not lend it, stake it, or invest it. Direct transfers to the contract revert; ETH arrives only through a mint.",
  },
  {
    k: "ARTWORK",
    v: "Generated onchain when it is asked for. No IPFS, no server, no fonts. 2000 × 2800, black ground, white marks, no other colours and no type on the face.",
  },
];

export const ABOUT_FACTS: Fact[] = [
  ...FACTS.slice(0, 2),
  {
    k: "RECOMPOSITION",
    v: "Shapes you own can be composed into one, or split into smaller denominations. Composing keeps one token's id and seed and burns the others into it; splitting burns the input and issues a fresh token per output. Output denominations must sum to exactly the input's backing. No ETH moves, and no fee is charged either way.",
  },
  ...FACTS.slice(2),
];
