// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A split child's creation provenance for its metadata, or the all-zero value for a
///         token that was never minted by `split`/`splitTo`.
/// @dev `parentDenomIndex` is the immediate parent's denomination at split time; `originDenomIndex`
///      is the root split ancestor's denomination. Both are ignored when `isSplitChild` is false.
///      The renderer emits the "Split From" / "Split Origin" traits from these, omitted entirely
///      when `isSplitChild` is false (METADATA.md).
struct SplitProvenance {
    bool isSplitChild;
    uint8 parentDenomIndex;
    uint8 originDenomIndex;
}

/// @title IShapeRenderer
/// @notice The fully onchain renderer for Shape tokens.
/// @dev Every function is `pure`. The renderer holds no state, owner or initialiser, so for the
///      same arguments it returns the same output. `Shapes` stores the `name` prefix and
///      `description` copy and supplies it per call.
///
///      Grammar v2 adds a second geometry source for a compose or split result: a materialized
///      module byte array (`ModuleCodec`) in place of a seed. Each `*Sampled` function is the same
///      read over that source. Positions, size and weight derive from the grid and card constants
///      on both paths, so a sampled and a seed-based card at the same denomination and ink gene
///      share every constant except the module identities.
interface IShapeRenderer {
    /// @notice The complete SVG document for a token.
    /// @dev The artwork is a function of the seed, the denomination and the ink gene, so this
    ///      takes no token id. `inverted` swaps the two colors: false is a dark field with light
    ///      marks, true is the inverse used by the Black Shape. `inkGene` (0..6,
    ///      INK_GENES_IMPL_SPEC.md) supplies the solid probability: each module's solid state is
    ///      drawn against `GENE_PROBABILITY[inkGene]`.
    function renderSVG(bytes32 seed, uint256 amountWei, bool inverted, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice `renderSVG`, reading a materialized module array in place of a seed.
    function renderSVGSampled(bytes calldata modules, uint256 amountWei, bool inverted, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice The metadata JSON for a token, with the SVG inlined as a base64 data URI.
    /// @dev `originCount` and `inverted` drive the provenance traits (Formation, Independent
    ///      Origins, Origin Density, Complete, Black). `inverted` is the token's Black state.
    ///      `inkGene` drives both the artwork (see `renderSVG`) and the `Ink` trait. `composeDepth`
    ///      is the token's reversible-compose stack depth, surfaced as the `Compose Depth` trait;
    ///      it is the one input that reads mutable chain state. `namePrefix` and `description`
    ///      are the editorial copy the caller supplies. `ownerToken`
    ///      names the collection owner token: `true` appends `, Contract Owner` to `namePrefix`
    ///      plus the decimal token id and adds a value-only `{"value":"Contract Owner"}` attribute
    ///      (no `trait_type`); `false` uses `namePrefix` plus the decimal token id, with no such
    ///      attribute. `description` is emitted verbatim. The renderer neither stores nor escapes
    ///      caller-supplied copy; the caller owns its content.
    function metadataJSON(
        bytes32 seed,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene,
        uint256 composeDepth,
        string calldata namePrefix,
        string calldata description,
        bool ownerToken
    ) external pure returns (string memory);

    /// @notice `metadataJSON`, reading a materialized module array in place of a seed.
    /// @dev `splitInfo` is the extra argument over `metadataJSON`. A split child always carries
    ///      materialized geometry, so "Split From" and "Split Origin" reach the renderer through
    ///      this path. `Shapes.tokenURI` passes the all-zero, non-split value for a compose
    ///      survivor with no split ancestry.
    function metadataJSONSampled(
        bytes calldata modules,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene,
        uint256 composeDepth,
        string calldata namePrefix,
        string calldata description,
        SplitProvenance calldata splitInfo,
        bool ownerToken
    ) external pure returns (string memory);

    /// @notice A base64 `data:application/json` URI wrapping `metadataJSON`.
    /// @dev `ownerToken` names the collection owner token: `true` appends `, Contract Owner` to
    ///      `namePrefix` plus the decimal token id and adds a value-only `Contract Owner`
    ///      attribute; `false` uses `namePrefix` plus the decimal token id, with no such
    ///      attribute.
    function tokenURI(
        bytes32 seed,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene,
        uint256 composeDepth,
        string calldata namePrefix,
        string calldata description,
        bool ownerToken
    ) external pure returns (string memory);

    /// @notice A base64 `data:application/json` URI wrapping `metadataJSONSampled`.
    /// @dev `ownerToken` names the collection owner token, as in `tokenURI`.
    function tokenURISampled(
        bytes calldata modules,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene,
        uint256 composeDepth,
        string calldata namePrefix,
        string calldata description,
        SplitProvenance calldata splitInfo,
        bool ownerToken
    ) external pure returns (string memory);

    /// @notice The module glyph sequence used as the `Modules` trait.
    /// @dev The glyph stream depends on `inkGene` through the same solid/outline draws
    ///      `renderSVG` uses, so it takes the same argument.
    function moduleSequence(bytes32 seed, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice `moduleSequence`, reading a materialized module array in place of a seed.
    function moduleSequenceSampled(bytes calldata modules, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice The canonical module glyphs arranged in the Shape's denomination grid.
    /// @dev Cells are separated by one ASCII space and rows by one `\n`, with no trailing
    ///      separator. A human-readable view of the modules `moduleSequence` returns. Contracts
    ///      should read `IShapeGeometry.moduleAt` for structured data.
    function renderUnicode(bytes32 seed, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice `renderUnicode`, reading a materialized module array in place of a seed.
    function renderUnicodeSampled(bytes calldata modules, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (string memory);
}
