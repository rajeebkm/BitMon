// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

/**
 * @title Address type for 1inch contracts
 * @notice Utility library for Address type operations  
 */

type Address is uint256;

library AddressLib {
    function get(Address addr) internal pure returns (address) {
        return address(uint160(Address.unwrap(addr)));
    }

    function wrap(address addr) internal pure returns (Address) {
        return Address.wrap(uint256(uint160(addr)));
    }
} 