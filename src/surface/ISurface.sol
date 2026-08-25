// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Vendored subset of the PND Surface protocol external ABI, matching the
// mainnet-deployed SurfaceFactory (0xdb81...8094) and PooledSurface
// implementation (0xd2e3...21eA). Only the members this port calls are
// declared. Struct field order and types are byte-identical to the deployed
// contracts; the fork test binds against the live factory to enforce that.

/// @notice Token id assignment mode. Pooled: an authorized minter chooses each
///         id and is the only burner; a burned id may be reminted.
enum IdMode {
    Sequential,
    Pooled
}

/// @notice Collection settings passed to the factory at creation. Field order
///         matches the deployed SurfaceConfig tuple exactly.
struct SurfaceConfig {
    uint256 supplyCap; // 0 = open supply
    uint16 royaltyBps; // EIP-2981, advisory
    address royaltyReceiver; // 0 = owner()
    address renderer; // provides tokenURI; 0 requires a factory default (mainnet default is 0)
    bool rendererLocked; // one-way
    bool supplyLocked; // one-way
}

/// @notice The mainnet SurfaceFactory. `createPooledSurface` clones a
///         PooledSurface and grants the caller-supplied minters in one tx.
interface ISurfaceFactory {
    /// @dev `primaryMinter` must be a member of `initialMinters` (or zero), or
    ///      the call reverts PrimaryMinterNotAuthorized.
    function createPooledSurface(
        string calldata name,
        string calldata symbol,
        address owner,
        SurfaceConfig calldata cfg,
        address[] calldata initialMinters,
        address primaryMinter,
        address[] calldata creators
    ) external returns (address collection);

    function pooledImplementation() external view returns (address);
    function defaultRenderer() external view returns (address);
    function catalog() external view returns (address);
    function isSurface(address collection) external view returns (bool);
}

/// @notice The pooled-collection members this minter calls. The collection is
///         an OZ ERC721; `ownerOf` reverts for a nonexistent id.
interface IPooledSurface {
    /// @notice Authorized minters only. Mints `tokenId` to `to` with a
    ///         core-assigned seed (this port ignores that seed).
    function mintToId(address to, uint256 tokenId) external;

    /// @notice Authorized minters only in pooled mode. Burns any id regardless
    ///         of holder, so the caller enforces its own ownership rule first.
    function burn(uint256 tokenId) external;

    function ownerOf(uint256 tokenId) external view returns (address);
    function isMinter(address minter) external view returns (bool);
    function idMode() external view returns (IdMode);

    /// @notice ERC-4906 refresh signal. Callable by the current renderer or an
    ///         owner/admin.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
}

/// @notice The renderer ABI the core delegates tokenURI/contractURI to. The
///         collection is an explicit parameter, never msg.sender.
interface ISurfaceRenderer {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
    function contractURI(address collection) external view returns (string memory);
}
