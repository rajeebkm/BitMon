// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { Address } from "../libraries/AddressLib.sol";

import { Timelocks } from "../libraries/TimelocksLib.sol";

import { IBaseEscrow } from "./IBaseEscrow.sol";

/**
 * @title Escrow Factory interface for cross-chain atomic swap.
 * @notice Interface to deploy escrow contracts for the destination chain and to get the deterministic address of escrow on destination chain.
 * @custom:security-contact security@1inch.io
 */
interface IEscrowFactory {
    struct ExtraDataArgs {
        bytes32 hashlockInfo; // Hash of the secret or the Merkle tree root if multiple fills are allowed
        uint256 dstChainId;
        Address dstToken;
        uint256 deposits;
        Timelocks timelocks;
    }

    struct DstImmutablesComplement {
        Address maker;
        uint256 amount;
        Address token;
        uint256 safetyDeposit;
        uint256 chainId;
    }

    error InsufficientEscrowBalance();
    error InvalidCreationTime();
    error InvalidPartialFill();
    error InvalidSecretsAmount();

    /**
     * @notice Emitted on EscrowDst deployment.
     * @param escrow The address of the created escrow.
     * @param hashlock The hash of the secret.
     * @param taker The address of the taker.
     * @param creator The address of who created the escrow (maker, resolver, etc).
     * @param creatorType Type of creator: 0=Resolver, 1=Maker, 2=Taker, 3=Other
     */
    event DstEscrowCreated(
        address escrow, 
        bytes32 hashlock, 
        Address taker,
        address indexed creator,
        uint8 creatorType
    );

    /* solhint-disable func-name-mixedcase */
    /// @notice Returns the address of implementation on the destination chain.
    function ESCROW_DST_IMPLEMENTATION() external view returns (address);
    /* solhint-enable func-name-mixedcase */

    /**
     * @notice Creates a new escrow contract for taker on the destination chain.
     * @dev The caller must send the safety deposit in the native token along with the function call
     * and approve the destination token to be transferred to the created escrow.
     * @param dstImmutables The immutables of the escrow contract that are used in deployment.
     */
    function createDstEscrow(IBaseEscrow.Immutables calldata dstImmutables) external payable;

    /**
     * @notice Returns the deterministic address of the destination escrow based on the salt.
     * @param immutables The immutable arguments used to compute salt for escrow deployment.
     * @return The computed address of the escrow.
     */
    function addressOfEscrowDst(IBaseEscrow.Immutables calldata immutables) external view returns (address);
}
