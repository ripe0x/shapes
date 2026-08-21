// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Versioned structured access to the canonical Shapes visual grammar.
/// @dev Tuple returns intentionally keep the renderer's existing public Card/Module structs
///      source-compatible while giving external contracts a stable interface. Grammar v2 adds a
///      second geometry source: a materialized module byte array (`ModuleCodec`) in place of a
///      seed. The `*Sampled` functions are the same reads over that source; grammar v1's seed-
///      based functions are unchanged.
interface IShapeGeometry {
    error ModuleIndexOutOfRange(uint256 index, uint256 count);
    /// @dev `composeSampled` and its callers require `modules.length` to equal the grid's cell
    ///      count for `amountWei`.
    error InvalidModuleLength(uint256 expected, uint256 actual);
    /// @dev A byte in a materialized array failed `ModuleCodec.isValid`.
    error InvalidModuleByte(uint256 index, bytes1 encoded);

    function grammarVersion() external pure returns (uint32);
    function grammarHash() external pure returns (bytes32);

    function cardGeometry(bytes32 seed, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (
            uint8 denominationIndex,
            uint256 cols,
            uint256 rows,
            uint256 cell,
            uint256 target,
            uint256 weight,
            uint256 solidProbability,
            uint256 moduleCount
        );

    /// @notice `cardGeometry`, reading a materialized module array instead of a seed.
    function cardGeometrySampled(bytes calldata modules, uint256 amountWei, uint8 inkGene)
        external
        pure
        returns (
            uint8 denominationIndex,
            uint256 cols,
            uint256 rows,
            uint256 cell,
            uint256 target,
            uint256 weight,
            uint256 solidProbability,
            uint256 moduleCount
        );

    function moduleAt(bytes32 seed, uint256 amountWei, uint8 inkGene, uint256 index)
        external
        pure
        returns (
            uint8 kind,
            bool solid,
            uint16 rotation,
            uint256 cx,
            uint256 cy,
            uint256 size,
            uint256 weight
        );

    /// @notice `moduleAt`, reading a materialized module array instead of a seed.
    function moduleAtSampled(bytes calldata modules, uint256 amountWei, uint8 inkGene, uint256 index)
        external
        pure
        returns (
            uint8 kind,
            bool solid,
            uint16 rotation,
            uint256 cx,
            uint256 cy,
            uint256 size,
            uint256 weight
        );
}
