// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {BLS} from "../src/BLS.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";

/// @notice Run through eth_call with no funds, by scripts/fuji-smoke.sh. The constructor reverts unless the
///         target chain gives the same answers as the test fixture.
contract FujiSmoke {
    constructor(uint256[4] memory pk, bytes32 message, uint256 hx, uint256 hy, uint256[2] memory sig) {
        (uint256 x, uint256 y) = BLS.hashToG1(message);
        require(x == hx && y == hy, "hash to curve differs");
        require(BLS.verify(pk, message, sig), "good signature rejected");
        require(!BLS.verify(pk, keccak256("other"), sig), "bad signature accepted");
        require(BLS.isValidPublicKey(pk), "good key rejected");
        require(block.number == 0 || blockhash(block.number - 1) != 0, "no blockhash");
        new RandomnessOracle(pk, payable(address(1)), 1);

        // Last, because a precompile that rejects its input burns all the gas sent to it.
        pk[0] += 1;
        require(!BLS.isValidPublicKey(pk), "bad key accepted");
    }
}
