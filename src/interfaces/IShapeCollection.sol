// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IShapeCollection
/// @notice The collection's metadata: the editorial copy both token and contract metadata are
///         built from, the contract-level metadata a marketplace reads, and seeded previews of
///         cards that no token needs to exist for.
/// @dev The copy is stored here and edited by the admin of the `Shapes` this contract is bound
///      to, until that token's presentation is locked. `Shapes.tokenURI` and `Shapes.contractURI`
///      read it back from this address.
///
///      Every rendered output is a function of a seed and the denomination ladder, drawn through
///      the renderer this contract was constructed with. A function that takes a seed returns
///      deterministic output for that seed. The ones that take none use `seed()`, which advances
///      once per block.
interface IShapeCollection {
    /// @notice Emitted when the admin rewrites the metadata copy.
    event MetadataCopySet(string tokenNamePrefix, string description);

    error DenominationIndexOutOfRange(uint256 index);

    /// @dev Metadata copy is written verbatim into JSON, so a value is rejected when it carries a
    ///      `"`, a `\`, or a C0 control byte (which would break or restructure the document), is
    ///      not well-formed UTF-8 (which a strict consumer would reject), or exceeds its length
    ///      cap. `field` is 0 name/prefix, 1 description.
    error InvalidCopy(uint8 field);

    /// @dev `setMetadataCopy` reverts this when the caller is not `IShapes(shapes()).admin()`.
    ///      Same error `IAdminControl` declares, so either ABI decodes it identically.
    error AdminUnauthorizedAccount(address account);

    /// @dev `setMetadataCopy` reverts this once `IShapes(shapes()).presentationLocked()` is true.
    ///      Same error `IShapes` declares, so either ABI decodes it identically.
    error PresentationIsLocked();

    /// @notice The renderer every output is drawn through.
    function renderer() external view returns (address);

    /// @notice The `Shapes` token this collection describes. Its `admin()` may edit the copy and
    ///         its `presentationLocked()` freezes it. Immutable, set at construction.
    function shapes() external view returns (address);

    /// @notice The current block's seed, `block.prevrandao` hashed with the block number. Any two
    ///         calls in the same block agree. Pass it to `imageFor` or `cardFor` to reproduce an
    ///         output later.
    function seed() external view returns (bytes32);

    /* -------------------------------- copy -------------------------------- */

    /// @notice The per-token metadata name prefix. A token's `name` is this followed by its id.
    /// @dev Read by `Shapes.tokenURI` and written verbatim into every token's metadata.
    function tokenNamePrefix() external view returns (string memory);

    /// @notice The description emitted by both token metadata and `Shapes.contractURI`, so the
    ///         collection and its tokens carry one description.
    function description() external view returns (string memory);

    /// @notice Set the token name prefix and the shared description together.
    /// @dev Callable only by `IShapes(shapes()).admin()`, and only while that token's
    ///      `presentationLocked()` is false; otherwise reverts `IShapes.PresentationIsLocked`.
    ///      Both arguments must be well-formed UTF-8, length-capped (64-byte prefix, 2048-byte
    ///      description), and free of bytes JSON forbids unescaped (`"`, `\`, C0 controls).
    ///      Marketplaces re-read after a copy change when the admin then calls
    ///      `Shapes.refreshMetadata`.
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_) external;

    /* ---------------------------- collection ------------------------------ */

    /// @notice Contract-level metadata URI, as a base64 `data:application/json`.
    /// @dev `name` and `description` are the editorial copy the caller supplies, emitted verbatim;
    ///      the `image` is generated here. `Shapes.contractURI` supplies its ERC-721 `name()` and
    ///      the `description` stored here.
    function contractURI(string calldata name_, string calldata description_)
        external
        view
        returns (string memory);

    /// @notice The contract-level metadata JSON: `name` and `description` from the caller, `image` inline.
    function json(string calldata name_, string calldata description_) external view returns (string memory);

    /// @notice The collection image at the current block's seed.
    function image() external view returns (string memory);

    /// @notice The collection image at `root`: a looping filmstrip of one frame per denomination
    ///         and variant, stepped one frame at a time inside a one-frame window, on a square
    ///         white ground with the card inset, rounded and shadowed.
    function imageFor(bytes32 root) external view returns (string memory);

    /// @notice A card at `denomIndex`, seeded by the current block.
    function card(uint8 denomIndex) external view returns (string memory);

    /// @notice The card `seed` and `denomIndex` produce, with the ink gene derived the way a mint
    ///         derives it. No token is involved.
    function cardFor(bytes32 cardSeed, uint8 denomIndex) external view returns (string memory);
}
