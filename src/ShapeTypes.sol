// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ShapeTypes
/// @notice Every type shared by `Shapes`, its linked libraries and its interfaces: the formation
///         enum, the token's storage layout, and the structs its views return.
/// @dev `Shapes` declares the storage; the libraries receive pointers into it. Both sides must see
///      one declaration of each struct, which is why they live here rather than in either.

/// @notice Stable, machine-readable formation classes. Numeric values are part of the API.
enum ShapeFormation {
    Fragment,
    Direct,
    Composed,
    Complete,
    Black
}

/* ------------------------------- storage ------------------------------- */

/// @notice Per-token state. Storing the denomination index rather than a wei amount makes an
///         off-ladder backing value unrepresentable.
/// @dev `originCount` is the number of direct mints credited to this token, conserved across
///      compose, decompose and split. `isBlack` marks a sacrificed token. `inkGene` is assigned at
///      mint and afterwards changes only through `compose`; `decompose` restores the pre-compose
///      value and `split` copies it to every child. See INK_GENES_IMPL_SPEC.md.
struct ShapeData {
    bytes32 seed;
    uint8 denomIndex;
    uint32 originCount;
    bool isBlack;
    uint8 inkGene;
}

/// @notice One burned compose input, holding everything `decompose` needs to re-mint it verbatim.
/// @dev `modules` is the input's sampled geometry, empty if it had none. `id` is the token id
///      narrowed to `uint96`. Ids are sequential and issued one per mint, so the narrowing is
///      lossless below 2**96 ids, about 7.9e28 mints, each of which costs at least one 0.01 ETH
///      unit of backing.
struct ComposeInput {
    bytes32 seed;
    uint96 id;
    uint32 originCount;
    uint8 denomIndex;
    uint8 inkGene;
    bytes modules;
}

/// @notice State needed to undo one compose.
/// @dev `decompose` restores the survivor's prior state from `survivor*` and re-mints each burned
///      input under its original id. The record holds everything decompose needs: no
///      caller-supplied state and no event history. `ownerTokenFrom` is the owner token's id plus
///      one when this compose moved ownership from one of `inputs` to the survivor, else zero.
///      `decompose` reads it to return ownership to that input.
struct ComposeRecord {
    uint8 survivorDenomIndex;
    uint32 survivorOriginCount;
    uint8 survivorInkGene;
    uint96 ownerTokenFrom;
    bytes survivorModules;
    ComposeInput[] inputs;
}

/// @notice Parent snapshot shared by every child of one split.
/// @dev `parentModules` records the parent's effective geometry at split time, for provenance; it
///      is not the pool the children sampled from. `originDenomIndex` keeps the root split
///      ancestor's denomination: the parent's own value when the parent was itself a split child,
///      else the parent's denomination. `parentId` allows the split's sampling source to be
///      reconstructed from the parent's compose history. See SAMPLING_SPEC.md.
struct SplitRecord {
    bytes32 parentSeed;
    uint96 parentId;
    uint8 parentDenomIndex;
    uint8 parentInkGene;
    uint8 originDenomIndex;
    bytes parentModules;
}

/// @notice One split child's reference to its shared `SplitRecord`: which record, and the child's
///         index within that split.
/// @dev `exists` separates a real reference at record 0, child 0 from the mapping's zero default
///      for a token that was never a split child.
struct SplitOriginRef {
    bool exists;
    uint64 recordIndex;
    uint32 childIndex;
}

/// @notice The token state `RecompositionOps` writes, and the only storage it can reach.
/// @dev `Shapes` declares one of these and hands a pointer to it. Backing, fees, the owner token,
///      the admin address and the presentation pointers are not in here and no library can write
///      them. `modules` is empty for a token whose geometry derives from `seed` under grammar v1:
///      an original mint, never composed or split. It is nonempty for a compose survivor or a
///      split child, holding one `ModuleCodec` byte per grid cell at the token's current
///      denomination, and is restored verbatim by `decompose`. See SAMPLING_SPEC.md.
struct ShapeStore {
    mapping(uint256 tokenId => ShapeData) shapes;
    mapping(uint256 tokenId => bytes) modules;
    /// @dev Per-survivor LIFO stack of reversible composes. `compose` pushes, `decompose` pops the
    ///      top, so one survivor can be composed repeatedly and unwound newest first. A record is
    ///      left inert if the survivor is later burned or marked Black: `decompose`'s ownership
    ///      and `isBlack` checks reject every such case. See DECOMPOSE_SPEC.md.
    mapping(uint256 survivorId => ComposeRecord[]) composeStack;
    /// @dev Append-only, one entry per split operation. Referenced by `splitOriginRef`.
    SplitRecord[] splitRecords;
    /// @dev No entry for an original mint or for a token re-minted by `decompose`. A split child's
    ///      entry is never deleted, so it survives the child's own later compose or split.
    mapping(uint256 childId => SplitOriginRef) splitOriginRef;
    uint256 totalSupply;
    uint256 totalMinted;
}

/* -------------------------------- views -------------------------------- */

/// @notice The complete protocol state of one live Shape in a single read.
/// @dev Returned by `IShapes.shapeState` and `IShapes.previewCompose`. `faceValueWei` is the
///      Shape's denomination and survives sacrifice; `redeemableValueWei` is zero for a Black
///      Shape and otherwise equals face value. `modules` is the token's materialized module array
///      (`ModuleCodec`), empty when its geometry derives from `seed` under grammar v1.
struct ShapeState {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bool isBlack;
    ShapeFormation formation;
    uint256 faceValueWei;
    uint256 redeemableValueWei;
    bytes modules;
}

/// @notice One deterministic child returned by `IShapes.previewSplit`.
/// @dev `modules` is the child's materialized module bytes, exactly what `split` stores for it
///      (SAMPLING_SPEC.md section 6).
struct ShapeChildPreview {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    uint256 faceValueWei;
    bytes modules;
}

/// @notice One burned compose input as returned by `IShapes.composeRecordAt`.
/// @dev `modules` is the input's materialized geometry snapshot at the time it was burned, empty
///      if it had none (an unmaterialized original mint).
struct ComposeInputView {
    uint256 id;
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bytes modules;
}

/// @notice One reversible compose record as returned by `IShapes.composeRecordAt`: the survivor's
///         pre-compose state and every input burned into it, in the order recorded.
/// @dev `survivorModules` is the survivor's materialized geometry snapshot before the compose,
///      empty if it had none. `ownerTokenFrom` is the id of the input that held collection
///      ownership before this compose, or `type(uint256).max` when none did, the same no-owner-
///      token id `OwnerTokenMoved` uses; `decompose` restores ownership to that input. The stored
///      id-plus-one encoding is never returned.
struct ComposeRecordView {
    uint8 survivorDenominationIndex;
    uint32 survivorOriginCount;
    uint8 survivorInkGene;
    bytes survivorModules;
    uint256 ownerTokenFrom;
    ComposeInputView[] inputs;
}
