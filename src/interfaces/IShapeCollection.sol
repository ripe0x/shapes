// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeCollection
/// @notice Collection-level presentation for Shapes: the contract-level metadata a marketplace
///         reads, and seeded previews of cards that no token needs to exist for.
/// @dev Every output is a function of a seed and the denomination ladder, rendered through the
///      renderer this contract was constructed with. Functions that take a seed are
///      reproducible forever; the ones that do not use `seed()`, which advances once per block.
interface IShapeCollection {
    error DenominationIndexOutOfRange(uint256 index);

    /// @notice The renderer every output is drawn through.
    function renderer() external view returns (address);

    /// @notice The current block's seed. Advances once per block, so any two calls in the same
    ///         block agree. Pass it to `imageFor` or `cardFor` to pin an output permanently.
    function seed() external view returns (bytes32);

    /// @notice Contract-level metadata URI, as a base64 `data:application/json`.
    /// @dev `name` and `description` are the editorial copy the caller supplies, emitted verbatim;
    ///      the `image` is generated here. `Shapes` stores that copy and passes it through.
    function contractURI(string calldata name, string calldata description)
        external
        view
        returns (string memory);

    /// @notice The contract-level metadata JSON: `name` and `description` from the caller, `image` inline.
    function json(string calldata name, string calldata description) external view returns (string memory);

    /// @notice The collection image at the current block's seed.
    function image() external view returns (string memory);

    /// @notice The collection image at `root`: a looping filmstrip of one frame per denomination
    ///         and variant, stepped one frame at a time inside a one-frame window, on a square
    ///         white ground with the card inset, rounded and shadowed.
    function imageFor(bytes32 root) external view returns (string memory);

    /// @notice A card at `denomIndex`, seeded by the current block.
    function card(uint8 denomIndex) external view returns (string memory);

    /// @notice The card `seed` and `denomIndex` produce, with the ink gene derived exactly as a
    ///         mint would derive it. No token is involved.
    function cardFor(bytes32 cardSeed, uint8 denomIndex) external view returns (string memory);
}
