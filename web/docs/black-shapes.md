# Black Shapes

`burnBacking` is the one operation that destroys value on purpose. It is available only to the owner of an **apex Complete** Shape: 100 ETH, index 8, carrying all 10000 origins.

```solidity
function burnBacking(uint256 tokenId) external;

function isBlackShape(uint256 tokenId) external view returns (bool);
function blackShapeCount() external view returns (uint256);
function burnedBacking() external view returns (uint256);
```

## Rules

- The caller owns the token, it is live, and it is not already Black.
- `denomIndexOf(tokenId) == 8` and `originCountOf(tokenId) == 10000`, else `NotApexComplete(tokenId)`. A 100 ETH Shape minted directly has one origin and does not qualify; only one assembled from 10000 direct mints does.
- One way. There is no reverse.

## Effect

Exactly 100 ETH leaves the reserve to `0x000000000000000000000000000000000000dEaD`. `redeemableBacking` drops by 100 ETH, `burnedBacking` rises by 100 ETH, `blackShapeCount` rises by one. The token keeps its id, owner, seed, origins, denomination index 8 and modules, and is marked Black.

A Black Shape:

| Read or action | Result |
| --- | --- |
| `valueOf`, `backingOf` | 0 |
| `denomIndexOf` | 8 |
| `formationOf` | 4 (`Black`) |
| `isComplete` | false |
| `tokenURI` | The same geometry, inverted: light field, dark marks |
| `transferFrom`, `safeTransferFrom` | Allowed |
| `burn` | Allowed; destroys it for zero, lowers `blackShapeCount` |
| `redeem*` | `TokenIsBlack` |
| `compose` as survivor or input, `decompose`, `split`, `burnBacking` | `TokenIsBlack` |

`burnedBacking` is monotonic. Burning a Black Shape for zero does not change it, because that ETH already left at `burnBacking`.

## Events

| Event | Count |
| --- | --- |
| `BlackShapeCreated(tokenId, burnedWei)` | Once, `burnedWei` = 100 ETH |
| `MetadataUpdate(tokenId)` (ERC-4906) | Once |

No `Transfer` is emitted; the token does not move. A Black Shape that is later burned emits `Transfer` to zero and `ShapeRedeemed` with `amountWei == 0`.
