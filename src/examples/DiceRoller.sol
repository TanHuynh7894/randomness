// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IRandomnessConsumer, RandomnessOracle} from "../RandomnessOracle.sol";

/// @title DiceRoller: sample consumer of RandomnessOracle.
/// @notice A player pays the oracle fee and gets a number from 1 to 6. Three rules any consumer should follow:
///         the callback only stores the result; `settle` finishes the roll if the callback failed; and
///         an expired roll is refunded, never redrawn, because a redraw would hand a withholding operator
///         another try.
contract DiceRoller is IRandomnessConsumer {
    struct Roll {
        address player;
        uint8 result; // 0 until settled
        bool refunded;
    }

    RandomnessOracle public immutable oracle;
    mapping(uint256 => Roll) public rolls;

    error NotOracle();
    error NotRefundable();

    event Rolled(uint256 indexed requestId, address indexed player);
    event Settled(uint256 indexed requestId, uint8 result);

    constructor(RandomnessOracle oracle_) {
        oracle = oracle_;
    }

    function roll() external payable returns (uint256 requestId) {
        requestId = oracle.requestRandomness{value: msg.value}();
        rolls[requestId].player = msg.sender;
        emit Rolled(requestId, msg.sender);
    }

    function onRandomness(uint256 requestId, uint256 randomness) external {
        if (msg.sender != address(oracle)) revert NotOracle();
        _settle(requestId, randomness);
    }

    /// @notice Anyone may finish a roll whose callback failed. Reverts if the oracle has no result yet.
    function settle(uint256 requestId) external {
        _settle(requestId, oracle.randomnessOf(requestId));
    }

    /// @notice Closes an expired request if needed and pays the fee back to the player.
    function refund(uint256 requestId) external {
        Roll storage r = rolls[requestId];
        if (r.player == address(0) || r.refunded) revert NotRefundable();
        RandomnessOracle.Status status = oracle.statusOf(requestId);
        if (status == RandomnessOracle.Status.Pending) {
            oracle.expire(requestId);
        } else if (status != RandomnessOracle.Status.Expired) {
            revert NotRefundable();
        }
        r.refunded = true;
        oracle.withdrawRefund(payable(r.player), oracle.fee());
    }

    function _settle(uint256 requestId, uint256 randomness) private {
        Roll storage r = rolls[requestId];
        if (r.result != 0) return;
        r.result = uint8(randomness % 6) + 1;
        emit Settled(requestId, r.result);
    }
}
