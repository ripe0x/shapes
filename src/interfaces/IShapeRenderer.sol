// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeRenderer
/// @notice The fully onchain renderer for Shape tokens.
/// @dev Every function is `pure`. The renderer holds no state, has no owner and no
///      initialiser; a deployed renderer's output for a given (seed, amount, tokenId) is
///      fixed for as long as the chain exists.
interface IShapeRenderer {
    /// @notice The complete SVG document for a token.
    /// @dev Takes no token id: a Shape carries no type, so its artwork is a function of its
    ///      seed, denomination and ink gene alone. `inverted` swaps the two colors: false is a
    ///      dark field with light marks, true is the exact inverse (the Black Shape). `inkGene`
    ///      (0..6, INK_GENES_IMPL_SPEC.md) replaces the card-level fill draw: module solid/
    ///      outline states are drawn against `GENE_PROBABILITY[inkGene]` rather than a per-seed
    ///      band. `isBlack`/`inverted` precedence over rendering is unchanged.
    function renderSVG(bytes32 seed, uint256 amountWei, bool inverted, uint8 inkGene)
        external
        pure
        returns (string memory);

    /// @notice The metadata JSON for a token, with the SVG inlined as a base64 data URI.
    /// @dev `originCount` and `inverted` drive the provenance traits (Formation, Independent
    ///      Origins, Origin Density, Complete, Black). `inverted` is the token's Black state.
    ///      `inkGene` drives both the artwork (see `renderSVG`) and the `Ink` trait.
    function metadataJSON(
        bytes32 seed,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene
    ) external pure returns (string memory);

    /// @notice A base64 `data:application/json` URI wrapping `metadataJSON`.
    function tokenURI(
        bytes32 seed,
        uint256 amountWei,
        uint256 tokenId,
        uint256 originCount,
        bool inverted,
        uint8 inkGene
    ) external pure returns (string memory);

    /// @notice The module glyph sequence used as the `Modules` trait.
    /// @dev The glyph stream depends on `inkGene` through the same solid/outline draws
    ///      `renderSVG` uses, so it takes the same argument.
    function moduleSequence(bytes32 seed, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (string memory);
}
