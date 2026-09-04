# Quickstart

Three calls cover most integrations: read a Shape's value, mint one, redeem one. Every example targets mainnet Shapes at `0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`.

## Read a Shape

```bash
cast call 0x6fe9193276bf7abcbee44ab7afd717d637d6faf0 \
  "valueOf(uint256)(uint256)" 1 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

`valueOf` returns the wei the current owner receives by redeeming the token. It reverts for an id that does not exist. `shapeState(tokenId)` returns every protocol fact about a live token in one call; see [Reading state](/docs/reading-state).

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({ chain: mainnet, transport: http() });
const shapes = "0x6fe9193276bf7abcbee44ab7afd717d637d6faf0";

const value = await client.readContract({
  address: shapes,
  abi: [{ type: "function", name: "valueOf", stateMutability: "view",
          inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "uint256" }] }],
  functionName: "valueOf",
  args: [1n],
});
```

## Mint a Shape

`mint(amountWei)` takes one of the nine denominations and must be paid exactly `amountWei + mintFee()`. The fee is flat per Shape and never enters the token's backing. Read `mintFee()` before every mint: the admin can change it, up to a cap of 0.01 ETH.

```bash
SHAPES=0x6fe9193276bf7abcbee44ab7afd717d637d6faf0
FEE=$(cast call $SHAPES "mintFee()(uint256)" --rpc-url $RPC)
AMOUNT=10000000000000000            # 0.01 ETH
cast send $SHAPES "mint(uint256)" $AMOUNT \
  --value $((AMOUNT + FEE)) --rpc-url $RPC --account <keystore>
```

```ts
const fee = await client.readContract({ address: shapes, abi, functionName: "mintFee" });
const amount = 10_000_000_000_000_000n; // 0.01 ETH
const hash = await wallet.writeContract({
  address: shapes, abi, functionName: "mint", args: [amount], value: amount + fee,
});
```

The token id is the return value, and it is also in the `ShapeMinted` event. Minting is open from the immutable `mintStart` timestamp (mainnet: `1788462000`); before it every mint entrypoint reverts `MintNotOpen`.

> A contract that calls `mint` receives the token through `onERC721Received`, because every Shape is minted with `_safeMint`. A contract without that hook reverts. See [Building on Shapes](/docs/integrating).

## Redeem a Shape

```bash
cast send $SHAPES "redeem(uint256)" 41 --rpc-url $RPC --account <keystore>
```

`redeem` burns the token and sends exactly `valueOf(tokenId)` to the caller. Only the owner can redeem; an approved operator cannot. `redeemTo` pays a different recipient and `redeemBatch` redeems several in one transfer. See [Redeeming](/docs/redeeming).

## Compose two Shapes

```bash
# 0.05 ETH survivor #12 absorbs five 0.01 ETH Shapes -> a 0.1 ETH Shape, still #12
cast send $SHAPES "compose(uint256,uint256[])" 12 "[13,14,15,16,17]" \
  --rpc-url $RPC --account <keystore>
```

The survivor keeps its id and seed and becomes the summed denomination. The sum must land on a denomination, the caller must own every input, and no ETH moves. `previewCompose` returns the resulting state without writing. See [Composing](/docs/composing).

## The denominations

| Index | ETH | Units of 0.01 | Grid |
| --- | --- | --- | --- |
| 0 | 0.01 | 1 | 5 × 5 |
| 1 | 0.05 | 5 | 4 × 5 |
| 2 | 0.1 | 10 | 4 × 4 |
| 3 | 0.5 | 50 | 3 × 4 |
| 4 | 1 | 100 | 3 × 3 |
| 5 | 5 | 500 | 2 × 3 |
| 6 | 10 | 1000 | 2 × 2 |
| 7 | 50 | 5000 | 1 × 2 |
| 8 | 100 | 10000 | 1 × 1 |

Mint and redeem work in wei amounts. `split` and the state views work in ladder indices. `denominationAt(index)` and `isSupportedDenomination(amountWei)` convert between them onchain. Sepolia runs the same ladder at 1/100 scale (0.0001 ETH to 1 ETH); see [Deployments](/docs/deployments).

## The ABI

Use the ABI from `deployments/1.json` in the repository or from the Foundry artifact `out/Shapes.sol/Shapes.json`. The [Contracts](/contracts) page on this site shows every function with its NatSpec and lets you call the read functions against the live chain.
