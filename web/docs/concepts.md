# Core concepts

The vocabulary the rest of these pages use. Every term maps to a function or a field on the Shapes contract.

## Denominations and units

A Shape's backing is one of nine fixed amounts. The contract stores a **denomination index** (0 to 8) per token, so an off-ladder amount is unrepresentable. The **unit** is the smallest denomination, 0.01 ETH on mainnet, and every denomination is a whole number of units: 1, 5, 10, 50, 100, 500, 1000, 5000, 10000.

| Function | Purpose |
| --- | --- |
| `unit()` | Wei in one unit (`1e16`) |
| `denominationCount()` | 9 |
| `denominationAt(uint8 index)` | Wei at a ladder index; reverts above 8 |
| `isSupportedDenomination(uint256 amountWei)` | Whether an amount is on the ladder |
| `denomIndexOf(uint256 tokenId)` | A live token's index |
| `backingOf(uint256 tokenId)` / `valueOf(uint256 tokenId)` | A live token's redeemable wei |

Mint takes wei; `split` takes indices; the state views return indices. Index 8, 100 ETH, is the **apex**.

## Seeds

Every token has an immutable `bytes32` seed, readable with `seedOf`. It decides the artwork and nothing else: redemption value comes from the denomination alone. A mint derives the seed from the token's ordinal and block data; a split child's seed is `childSeed(parentSeed, childIndex)`, which is `keccak256(abi.encodePacked(parentSeed, childIndex))`. A compose survivor keeps its own seed. Seeds are grindable by minting more tokens and are not secure randomness.

## Origins

An **origin** is one direct mint. Every mint credits its token with `originCount == 1`. Compose sums the inputs' origins onto the survivor, decompose gives them back, and split partitions them across the children, filling each child to capacity in listed order. Origins are conserved: the global sum only grows by minting and only shrinks by redeeming or burning a token. `originCountOf(tokenId)` reads a token's credit.

Origins measure how much of a Shape was minted directly rather than assembled. A 1 ETH Shape holds 100 units; it is **Complete** when it carries 100 origins, one per unit.

## Formations

`formationOf(tokenId)` returns a stable numeric class. The rule, from the token's denomination units, origin count and Black flag:

| Value | Name | Rule |
| --- | --- | --- |
| 0 | Fragment | `originCount == 0` |
| 1 | Direct | `originCount == 1` and not Complete |
| 2 | Composed | `originCount > 1` and not Complete |
| 3 | Complete | `units > 1` and `originCount == units` |
| 4 | Black | Backing burned; see [Black Shapes](/docs/black-shapes) |

The Black check runs first, then Complete, then the origin count. A 0.01 ETH Shape (1 unit) can never be Complete. `isComplete(tokenId)` is `formationOf(tokenId) == Complete`. Metadata strings such as the `Formation` trait are presentation; the number is the API.

## Ink gene

Every token carries an **ink gene**, 0 to 6, readable with `inkGeneOf`. It sets the probability that each module on the card is drawn solid rather than outlined: `Void`, `Faint`, `Sparse`, `Murk`, `Dense`, `Rich`, `Solid`. It is assigned at mint from the seed and denomination, changes on compose by a units-weighted walk over the inputs, is restored by decompose, and is copied from the parent to every split child. Every assignment emits `InkGene(tokenId, gene)`. INK_GENES_IMPL_SPEC.md in the repository has the exact rule.

## Modules and geometry

A card is a grid of **modules**, one per cell, from 25 at 0.01 ETH down to 1 at 100 ETH. An original mint derives its modules from the seed (grammar v1) and stores nothing; `modulesOf(tokenId)` is empty for it. Compose and split produce **sampled** modules: the survivor or each child stores one `ModuleCodec` byte per cell, sampled from the input tokens' modules, and emits `ModulesSampled`. `effectiveModulesOf(tokenId)` returns the bytes for either case. See [Geometry and rendering](/docs/geometry).

## Black Shapes

The owner of an apex Complete Shape (100 ETH, 10000 origins) may call `burnBacking`, which sends the 100 ETH to `0x000000000000000000000000000000000000dEaD` and marks the token Black. A Black Shape keeps its id, seed and geometry, renders inverted, has `valueOf == 0`, stays transferable, and can be burned for zero. It cannot be redeemed, composed, decomposed or burned again.

## Token ids

Ids are issued sequentially from 0; `totalMinted()` is the next id to issue. A mint and a split child each take a fresh id. Ids retired by redemption, burn, split or compose are never reissued, with one exception: `decompose` re-mints the exact inputs a compose consumed under their original ids and seeds. `exists(tokenId)` is the non-reverting liveness check, `totalSupply()` the live count.

## The owner token

Exactly one live Shape is the **owner token**, initially #0. `ownerToken()` returns its id and `owner()` returns its holder. Compose moves ownership to the survivor when the owner token is an input, decompose restores it, and split gives it to the first child. Redeeming or burning it ends collection ownership: `owner()` returns zero and `ownerToken()` reverts `NoOwnerToken`. Holding it grants no permissions. Every change emits `OwnerTokenMoved`.

## Protocol and presentation

The **protocol** is backing, ownership, recomposition and the reserve; it has no admin path. **Presentation** is the renderer, the collection metadata contract and their copy, all replaceable by `admin()` until `lockPresentation()`. Replacing the renderer changes how every token looks and nothing about what it is worth. See [Trust model](/docs/trust-model).
