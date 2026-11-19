import { getAddress, type Address } from 'viem';

/** A consumer that follows the three rules in the README. Self-contained, so it compiles when pasted anywhere. Solidity rejects an address literal without its checksum. */
export const consumerSnippet = (oracle: Address) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRandomnessOracle {
    function fee() external view returns (uint256);
    function requestRandomness() external payable returns (uint256 requestId);
    function randomnessOf(uint256 requestId) external view returns (uint256);
}

contract MyGame {
    IRandomnessOracle public constant ORACLE = IRandomnessOracle(${getAddress(oracle)});

    mapping(uint256 => uint256) public results;

    error NotOracle();

    function play() external payable returns (uint256 requestId) {
        requestId = ORACLE.requestRandomness{value: ORACLE.fee()}();
    }

    // Gets 200,000 gas. Only store the result here, and do nothing that can fail.
    function onRandomness(uint256 requestId, uint256 randomness) external {
        if (msg.sender != address(ORACLE)) revert NotOracle();
        results[requestId] = randomness;
    }

    // The way out if the callback failed: anyone can finish from the oracle's record.
    function settle(uint256 requestId) external {
        results[requestId] = ORACLE.randomnessOf(requestId);
    }

    // An expired request gets its fee back. Never redraw automatically: a redraw
    // gives an operator who is withholding results another try.
}
`;
