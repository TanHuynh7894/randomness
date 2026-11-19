// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {RandomnessOracle} from "../src/RandomnessOracle.sol";
import {DiceRoller} from "../src/examples/DiceRoller.sol";

/// @notice Needs ORACLE_PK_0..3 (from `npm run keygen`), ORACLE_OPERATOR and ORACLE_FEE (wei).
contract DeployOracle is Script {
    function run() external returns (RandomnessOracle oracle, DiceRoller dice) {
        uint256[4] memory pk =
            [vm.envUint("ORACLE_PK_0"), vm.envUint("ORACLE_PK_1"), vm.envUint("ORACLE_PK_2"), vm.envUint("ORACLE_PK_3")];
        vm.startBroadcast();
        oracle = new RandomnessOracle(pk, payable(vm.envAddress("ORACLE_OPERATOR")), vm.envUint("ORACLE_FEE"));
        dice = new DiceRoller(oracle);
        vm.stopBroadcast();
        console.log("ORACLE_ADDRESS=%s", address(oracle));
        console.log("DICE_ADDRESS=%s", address(dice));
    }
}
