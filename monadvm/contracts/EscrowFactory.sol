// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AddressLib, Address } from "./libraries/AddressLib.sol";
import { ImmutablesLib } from "./libraries/ImmutablesLib.sol";
import { TimelocksLib, Timelocks } from "./libraries/TimelocksLib.sol";
import { ProxyHashLib } from "./libraries/ProxyHashLib.sol";

import { IBaseEscrow } from "./interfaces/IBaseEscrow.sol";
import { IEscrowFactory } from "./interfaces/IEscrowFactory.sol";
import { EscrowDst } from "./EscrowDst.sol";

/**
 * @title Escrow Factory contract for Bitcoin <-> Monad atomic swaps
 * @notice Contract to create destination escrow contracts for cross-chain atomic swap.
 * @dev Simplified factory focused on destination escrows only, designed for Bitcoin <-> Monad swaps
 * @custom:security-contact security@1inch.io
 */
contract EscrowFactory is IEscrowFactory, Ownable {
    using SafeERC20 for IERC20;
    using AddressLib for Address;
    using TimelocksLib for Timelocks;

    /// @notice Implementation contract for destination escrows
    address public immutable ESCROW_DST_IMPLEMENTATION;
    
    /// @notice Bytecode hash for destination proxy contracts  
    bytes32 private immutable _PROXY_DST_BYTECODE_HASH;

    /// @notice Access token required for public operations
    IERC20 public immutable ACCESS_TOKEN;

    /// @notice Fee for creating destination escrows (in wei)
    uint256 public creationFee;

    /// @notice Treasury address for collecting fees
    address public treasury;

    error InvalidFeeAmount();
    error FeeTransferFailed();

    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    constructor(
        IERC20 accessToken,
        address owner,
        uint32 rescueDelayDst,
        uint256 _creationFee,
        address _treasury
    ) Ownable(owner) {
        ACCESS_TOKEN = accessToken;
        creationFee = _creationFee;
        treasury = _treasury;
        
        // Deploy destination escrow implementation
        ESCROW_DST_IMPLEMENTATION = address(new EscrowDst(rescueDelayDst, accessToken));
        
        // Compute proxy bytecode hash for destination escrows
        _PROXY_DST_BYTECODE_HASH = ProxyHashLib.computeProxyBytecodeHash(ESCROW_DST_IMPLEMENTATION);
    }

    // Allow factory to receive ETH
    receive() external payable {}

    /**
     * @notice Creates a new destination escrow contract for Bitcoin <-> Monad atomic swap
     * @dev The caller must send the safety deposit + creation fee in ETH, and approve tokens if needed
     * @param dstImmutables The immutables of the escrow contract that are used in deployment
     */
    function createDstEscrow(IBaseEscrow.Immutables calldata dstImmutables) external payable override {
        address token = dstImmutables.token.get();
        
        // Calculate required ETH
        uint256 requiredForEscrow = token == address(0) 
            ? dstImmutables.amount + dstImmutables.safetyDeposit  // ETH swap: amount + safety deposit
            : dstImmutables.safetyDeposit;                       // Token swap: only safety deposit
            
        uint256 totalRequired = requiredForEscrow + creationFee;
        
        if (msg.value != totalRequired) {
            revert InsufficientEscrowBalance();
        }

        // Set deployment timestamp in immutables
        IBaseEscrow.Immutables memory immutables = dstImmutables;
        immutables.timelocks = immutables.timelocks.setDeployedAt(block.timestamp);

        // Compute salt and deploy escrow with Create2
        bytes32 salt = ImmutablesLib.hashMem(immutables);
        
        // Create minimal proxy bytecode
        bytes memory bytecode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            ESCROW_DST_IMPLEMENTATION,
            hex"5af43d82803e903d91602b57fd5bf3"
        );

        // Deploy escrow with required ETH
        address escrow = Create2.deploy(requiredForEscrow, salt, bytecode);

        // For ERC20 swaps, transfer tokens to the escrow
        if (token != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, escrow, dstImmutables.amount);
        }

        // Transfer creation fee to treasury
        if (creationFee > 0 && treasury != address(0)) {
            (bool success, ) = treasury.call{value: creationFee}("");
            if (!success) revert FeeTransferFailed();
        }

        // Detect creator type for enhanced analytics
        uint8 creatorType = _detectCreatorType(msg.sender, dstImmutables);

        emit DstEscrowCreated(escrow, dstImmutables.hashlock, dstImmutables.taker, msg.sender, creatorType);
    }

    /**
     * @notice Helper function to detect creator type for analytics
     * @param creator The address creating the escrow
     * @param immutables The escrow immutables
     * @return creatorType 0=Resolver, 1=Maker, 2=Taker, 3=Other
     */
    function _detectCreatorType(address creator, IBaseEscrow.Immutables calldata immutables) 
        private 
        view 
        returns (uint8) 
    {
        address maker = immutables.maker.get();
        address taker = immutables.taker.get();
        
        if (creator == maker) return 1;        // Maker
        if (creator == taker) return 2;        // Taker  
        if (ACCESS_TOKEN.balanceOf(creator) > 0) return 0; // Resolver (has access tokens)
        return 3;                              // Other
    }

    /**
     * @notice Returns the deterministic address of the destination escrow
     * @param immutables The immutable arguments used to compute salt for escrow deployment
     * @return The computed address of the escrow
     */
    function addressOfEscrowDst(IBaseEscrow.Immutables calldata immutables) external view override returns (address) {
        // Use current block timestamp for address prediction
        IBaseEscrow.Immutables memory modifiedImmutables = immutables;
        modifiedImmutables.timelocks = immutables.timelocks.setDeployedAt(block.timestamp);
        
        bytes32 salt = ImmutablesLib.hashMem(modifiedImmutables);
        return Create2.computeAddress(salt, _PROXY_DST_BYTECODE_HASH, address(this));
    }

    /**
     * @notice Updates the creation fee (only owner)
     * @param newFee New creation fee in wei
     */
    function setCreationFee(uint256 newFee) external onlyOwner {
        uint256 oldFee = creationFee;
        creationFee = newFee;
        emit CreationFeeUpdated(oldFee, newFee);
    }

    /**
     * @notice Updates the treasury address (only owner)
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Emergency withdrawal function (only owner)
     * @param token Token address (address(0) for ETH)
     * @param amount Amount to withdraw
     * @param to Recipient address
     */
    function emergencyWithdraw(address token, uint256 amount, address to) external onlyOwner {
        if (token == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            if (!success) revert FeeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /**
     * @notice Returns the proxy bytecode hash for destination escrows
     * @return The bytecode hash used for Create2 address computation
     */
    function getProxyDstBytecodeHash() external view returns (bytes32) {
        return _PROXY_DST_BYTECODE_HASH;
    }
} 