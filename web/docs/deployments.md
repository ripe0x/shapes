# Deployments

Each network has one machine-readable record in the repository, `deployments/<chainId>.json`, which the site and the indexer read. The values below are copied from those records.

## Ethereum mainnet (chain id 1)

| Contract | Address |
| --- | --- |
| Shapes | `0x6fe9193276bf7abcbee44ab7afd717d637d6faf0` |
| ShapeRenderer | `0xe9ac8d910767d8efc71bf4f2cb5d7ef4c4f69295` |
| ShapeCollection | `0x9d1bd0c348900d5c6bce28148f2adc68f73c8af3` |
| ShapeAuctionHouse | `0x90b79dbf4f301c239983ee37e6a466132e1532df` |

| Parameter | Value |
| --- | --- |
| Deployment block | `25898721` |
| Mint fee at deploy | `1000000000000000` wei (0.001 ETH) |
| `mintStart` | `1788462000` (2026-09-03 15:00 ET) |
| Fee recipient | `0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72` (a Splits wallet) |
| Source commit | `a0a180bb5ae13bf5178c3f1f6deff32cc911f54f` |

Linked libraries, deployed once and bound into Shapes bytecode at deploy time with no setter:

| Library | Address |
| --- | --- |
| RecompositionOps | `0x94f63d2bcbcd6a3980bebbbe71de498e57f200f2` |
| AdminOps | `0xde64667e15ff3999f6fa0bcf9930c1653e361597` |
| ComposeCompute | `0xfbf7f6e9552f93d2dbd86e30b3b0637be5d520ea` |
| GeometrySampling | `0x991e1352b0f6131748f36d8d45f756d55ee930d3` |
| InkGenes | `0x34a7a97b92288b3f804f416b3b15214fb85e4200` |
| CopyValidation | `0xede9393cf5bd8037b9d4a15c2d864f97f98a9da7` |
| EIP712Signature | `0x48208746f35222a751e5fe286a8942bfceaf0906` |

`RecompositionOps` and `AdminOps` run by `DELEGATECALL` in Shapes storage and are part of the trusted implementation. The others are pure. None is callable on its own as part of the protocol; every entrypoint is on the Shapes address.

## Discovering addresses onchain

Read the live pointers from Shapes rather than hardcoding the periphery:

| Read | Returns |
| --- | --- |
| `renderer()` | The renderer `tokenURI` draws through; also answers `IShapeGeometry` |
| `collection()` | The collection metadata contract `contractURI` reads |
| `market()` | `(address target, bool locked)`, the canonical auction house or zero |
| `positions()` | `(address target, bool locked)`, the optional positions resolver or zero |

The renderer and collection can change until `lockPresentation()`; `presentationLocked()` says whether they are frozen. A pointer can change until its `lockPointer` call. See [Trust model](/docs/trust-model).
