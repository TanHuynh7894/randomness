// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {RandomnessBeacon} from "../src/RandomnessBeacon.sol";

contract Deploy is Script {
    function run() external returns (RandomnessBeacon beacon) {
        vm.startBroadcast();
        beacon = new RandomnessBeacon();
        vm.stopBroadcast();
        console.log("RandomnessBeacon:", address(beacon));
    }
}
