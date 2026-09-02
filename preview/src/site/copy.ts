import {formatEther} from "viem";
import {DENOMINATIONS} from "../chain/abi";

/** Fact rows shared by the mint screen and the how-it-works screen. Copy is final, from the
 *  handoff. The FEE row is built from the live mintFee() and the built ladder's apex, so the
 *  numbers match the contract and ladder in use; null (not read yet) gives the row without them. */

export interface Fact {
  k: string;
  v: string;
}

function feeFact(feeWei: bigint | null): Fact {
  const apex = DENOMINATIONS[DENOMINATIONS.length - 1];
  return {
    k: "FEE",
    v:
      feeWei === null
        ? "A flat fee per Shape, paid on top of its backing at mint. There is no burn fee and no transfer fee."
        : `${formatEther(feeWei)} ETH per Shape, paid on top of its backing at mint. A ${apex.label} ETH Shape costs ${formatEther(apex.wei + feeWei)} ETH total. There is no burn fee and no transfer fee.`,
  };
}

export const facts = (feeWei: bigint | null): Fact[] => [
  feeFact(feeWei),
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

export const aboutFacts = (feeWei: bigint | null): Fact[] => [
  ...facts(feeWei).slice(0, 2),
  {
    k: "RECOMPOSITION",
    v: "Shapes you own can be composed into one, or split into smaller denominations. Composing keeps one token's id and seed and burns the others into it; splitting burns the input and issues a fresh token per output. Output denominations must sum to exactly the input's backing. No ETH moves, and no fee is charged either way.",
  },
  ...facts(feeWei).slice(2),
];
