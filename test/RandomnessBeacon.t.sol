// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {RandomnessBeacon} from "../src/RandomnessBeacon.sol";

contract RejectsEther {
    RandomnessBeacon immutable beacon;
    bool public accepting;

    function setAccepting(bool value) external {
        accepting = value;
    }

    receive() external payable {
        require(accepting || msg.value == 0, "refused");
    }

    constructor(RandomnessBeacon beacon_) payable {
        beacon = beacon_;
    }

    function join(uint256 id, bytes32 commitment) external {
        beacon.commit{value: address(this).balance}(id, commitment);
    }

    function revealSecret(uint256 id, bytes32 secret) external {
        beacon.reveal(id, secret);
    }

    function claim(uint256 id) external {
        beacon.claim(id);
    }
}

contract ReentrantClaimer {
    RandomnessBeacon immutable beacon;
    uint256 roundId;
    bool public reentered;

    constructor(RandomnessBeacon beacon_) payable {
        beacon = beacon_;
    }

    function join(uint256 id, bytes32 commitment) external {
        roundId = id;
        beacon.commit{value: address(this).balance}(id, commitment);
    }

    function revealSecret(uint256 id, bytes32 secret) external {
        beacon.reveal(id, secret);
    }

    function claim(uint256 id) external {
        beacon.claim(id);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            beacon.claim(roundId);
        }
    }
}

contract RandomnessBeaconTest is Test {
    uint64 constant COMMIT = 100;
    uint64 constant REVEAL = 100;
    uint256 constant BOND = 1 ether;
    uint32 constant MIN = 2;

    bytes32 constant S_ALICE = keccak256("alice-secret");
    bytes32 constant S_BOB = keccak256("bob-secret");
    bytes32 constant S_CAROL = keccak256("carol-secret");

    RandomnessBeacon beacon;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    uint256 start;

    function setUp() public {
        beacon = new RandomnessBeacon();
        start = block.timestamp;
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    // Commitment layout stated here independently of the contract.
    function _hash(uint256 id, address who, bytes32 secret) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(beacon), id, who, secret));
    }

    function _round() internal returns (uint256 id) {
        vm.prank(creator);
        id = beacon.createRound(COMMIT, REVEAL, BOND, MIN);
    }

    function _commit(uint256 id, address who, bytes32 secret) internal {
        bytes32 h = _hash(id, who, secret);
        vm.prank(who);
        beacon.commit{value: BOND}(id, h);
    }

    function _reveal(uint256 id, address who, bytes32 secret) internal {
        vm.prank(who);
        beacon.reveal(id, secret);
    }

    function _toReveal() internal {
        vm.warp(start + COMMIT + 1);
    }

    function _toEnd() internal {
        vm.warp(start + COMMIT + REVEAL + 1);
    }

    /// Round with alice and bob committed, reveal phase open.
    function _twoCommitted() internal returns (uint256 id) {
        id = _round();
        _commit(id, alice, S_ALICE);
        _commit(id, bob, S_BOB);
        _toReveal();
    }

    function _expected(uint256 id, uint256 acc) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(beacon), id, acc)));
    }

    function _contribution(address who, bytes32 secret) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(who, secret)));
    }

    // --- createRound ---

    function test_createRound_rejectsSingleParticipantRounds() public {
        vm.expectRevert(RandomnessBeacon.BadParams.selector);
        beacon.createRound(COMMIT, REVEAL, BOND, 1);
    }

    function test_createRound_rejectsZeroBond() public {
        vm.expectRevert(RandomnessBeacon.BadParams.selector);
        beacon.createRound(COMMIT, REVEAL, 0, MIN);
    }

    function test_createRound_rejectsZeroDurations() public {
        vm.expectRevert(RandomnessBeacon.BadParams.selector);
        beacon.createRound(0, REVEAL, BOND, MIN);
        vm.expectRevert(RandomnessBeacon.BadParams.selector);
        beacon.createRound(COMMIT, 0, BOND, MIN);
    }

    function test_createRound_givesEachRoundItsOwnId() public {
        assertEq(_round(), 0);
        assertEq(_round(), 1);
    }

    // --- commit ---

    function test_commit_rejectsWrongBond() public {
        uint256 id = _round();
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.WrongBond.selector);
        beacon.commit{value: BOND - 1}(id, bytes32(uint256(1)));
    }

    function test_commit_rejectsSecondCommitFromSameAddress() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.AlreadyCommitted.selector);
        beacon.commit{value: BOND}(id, bytes32(uint256(1)));
    }

    function test_commit_rejectsAfterCommitPhase() public {
        uint256 id = _round();
        _toReveal();
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.commit{value: BOND}(id, bytes32(uint256(1)));
    }

    function test_commit_rejectsUnknownRound() public {
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.commit{value: BOND}(99, bytes32(uint256(1)));
    }

    // --- reveal ---

    function test_reveal_rejectsDuringCommitPhase() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.reveal(id, S_ALICE);
    }

    function test_reveal_rejectsAfterRevealPhase() public {
        uint256 id = _twoCommitted();
        _toEnd();
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.reveal(id, S_ALICE);
    }

    function test_reveal_rejectsWrongSecret() public {
        uint256 id = _twoCommitted();
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.BadReveal.selector);
        beacon.reveal(id, S_BOB);
    }

    function test_reveal_rejectsAddressThatDidNotCommit() public {
        uint256 id = _twoCommitted();
        vm.prank(carol);
        vm.expectRevert(RandomnessBeacon.NotCommitted.selector);
        beacon.reveal(id, S_CAROL);
    }

    function test_reveal_rejectsSecondReveal() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.AlreadyRevealed.selector);
        beacon.reveal(id, S_ALICE);
    }

    function test_commitment_copiedFromAnotherParticipantCannotBeRevealed() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        bytes32 copied = _hash(id, alice, S_ALICE);
        vm.prank(bob);
        beacon.commit{value: BOND}(id, copied);
        _toReveal();
        _reveal(id, alice, S_ALICE);
        vm.prank(bob);
        vm.expectRevert(RandomnessBeacon.BadReveal.selector);
        beacon.reveal(id, S_ALICE);
    }

    function test_commitment_fromAnotherRoundCannotBeRevealed() public {
        uint256 oldRound = _round();
        uint256 id = _round();
        bytes32 stale = _hash(oldRound, alice, S_ALICE);
        vm.prank(alice);
        beacon.commit{value: BOND}(id, stale);
        _toReveal();
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.BadReveal.selector);
        beacon.reveal(id, S_ALICE);
    }

    // --- finalize and output ---

    function test_finalize_producesOutputFromAllContributions() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);

        uint256 acc = _contribution(alice, S_ALICE) ^ _contribution(bob, S_BOB);
        assertEq(beacon.randomOf(id), _expected(id, acc));
        assertEq(uint8(beacon.statusOf(id)), uint8(RandomnessBeacon.Status.Finalized));
    }

    function test_output_doesNotDependOnRevealOrder() public {
        uint256 first = _twoCommitted();
        _reveal(first, alice, S_ALICE);
        _reveal(first, bob, S_BOB);
        beacon.finalize(first);
        uint256 acc = _contribution(alice, S_ALICE) ^ _contribution(bob, S_BOB);
        assertEq(beacon.randomOf(first), _expected(first, acc));

        start = block.timestamp;
        uint256 second = _twoCommitted();
        _reveal(second, bob, S_BOB);
        _reveal(second, alice, S_ALICE);
        beacon.finalize(second);
        assertEq(beacon.randomOf(second), _expected(second, acc));
    }

    function test_output_changesWhenOneSecretChanges() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        _commit(id, bob, S_CAROL);
        _toReveal();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_CAROL);
        beacon.finalize(id);

        uint256 withBobSecret = _contribution(alice, S_ALICE) ^ _contribution(bob, S_BOB);
        uint256 withCarolSecret = _contribution(alice, S_ALICE) ^ _contribution(bob, S_CAROL);
        assertEq(beacon.randomOf(id), _expected(id, withCarolSecret));
        assertTrue(beacon.randomOf(id) != _expected(id, withBobSecret));
    }

    function test_finalize_rejectsWhileRevealsArePending() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.finalize(id);
    }

    function test_finalize_rejectsDuringCommitPhaseEvenIfEveryoneCommitted() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        _commit(id, bob, S_BOB);
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.finalize(id);
    }

    function test_finalize_rejectsUnknownRound() public {
        vm.expectRevert(RandomnessBeacon.WrongPhase.selector);
        beacon.finalize(99);
    }

    function test_commit_rejectsSecondCommitEvenWithZeroCommitment() public {
        uint256 id = _round();
        vm.startPrank(alice);
        beacon.commit{value: BOND}(id, bytes32(0));
        vm.expectRevert(RandomnessBeacon.AlreadyCommitted.selector);
        beacon.commit{value: BOND}(id, bytes32(0));
        vm.stopPrank();
    }

    function test_finalize_rejectsSecondCall() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.expectRevert(RandomnessBeacon.AlreadyFinalized.selector);
        beacon.finalize(id);
    }

    function test_finalize_failsRoundWhenAnyoneWithholds() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _toEnd();
        beacon.finalize(id);
        assertEq(uint8(beacon.statusOf(id)), uint8(RandomnessBeacon.Status.Failed));
    }

    function test_finalize_failsRoundBelowMinimumParticipants() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        _toReveal();
        _reveal(id, alice, S_ALICE);
        beacon.finalize(id);
        assertEq(uint8(beacon.statusOf(id)), uint8(RandomnessBeacon.Status.Failed));
    }

    function test_randomOf_rejectsBeforeFinalize() public {
        uint256 id = _twoCommitted();
        vm.expectRevert(RandomnessBeacon.NoRandomness.selector);
        beacon.randomOf(id);
    }

    function test_randomOf_rejectsFailedRound() public {
        uint256 id = _twoCommitted();
        _toEnd();
        beacon.finalize(id);
        vm.expectRevert(RandomnessBeacon.NoRandomness.selector);
        beacon.randomOf(id);
    }

    // --- money ---

    function test_claim_returnsBondAfterSuccessfulRound() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.prank(alice);
        beacon.claim(id);
        assertEq(alice.balance, 10 ether);
        assertEq(address(beacon).balance, BOND);
    }

    function test_claim_refundsRevealersExactlyTheirBondWhenSomeoneWithheld() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        _commit(id, bob, S_BOB);
        _commit(id, carol, S_CAROL);
        _toReveal();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        _toEnd();
        beacon.finalize(id);
        vm.prank(alice);
        beacon.claim(id);
        vm.prank(bob);
        beacon.claim(id);
        assertEq(alice.balance, 10 ether);
        assertEq(bob.balance, 10 ether);
        assertEq(address(beacon).balance, BOND);
    }

    // One honest participant plus an attacker on 10 addresses who withholds the last one to abort.
    // If forfeited bonds were shared among revealers, the attacker would recover 0.9 of the bond.
    function test_abort_costsSybilAttackerTheFullBond() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        address[10] memory sybils;
        for (uint256 i = 0; i < 10; i++) {
            sybils[i] = address(uint160(0x1000 + i));
            vm.deal(sybils[i], BOND);
            _commit(id, sybils[i], bytes32(i));
        }
        _toReveal();
        _reveal(id, alice, S_ALICE);
        for (uint256 i = 0; i < 9; i++) {
            _reveal(id, sybils[i], bytes32(i));
        }
        _toEnd();
        beacon.finalize(id);
        assertEq(uint8(beacon.statusOf(id)), uint8(RandomnessBeacon.Status.Failed));

        uint256 attackerTotal;
        for (uint256 i = 0; i < 9; i++) {
            vm.prank(sybils[i]);
            beacon.claim(id);
            attackerTotal += sybils[i].balance;
        }
        assertEq(attackerTotal, 9 * BOND);
    }

    function test_forfeitedBonds_cannotBeClaimedByCreatorWhenNobodyRevealed() public {
        uint256 id = _twoCommitted();
        _toEnd();
        beacon.finalize(id);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            vm.prank(who);
            vm.expectRevert(RandomnessBeacon.NothingToClaim.selector);
            beacon.claim(id);
        }
        vm.prank(creator);
        vm.expectRevert(RandomnessBeacon.NothingToClaim.selector);
        beacon.claim(id);
        assertEq(creator.balance, 0);
        assertEq(address(beacon).balance, 2 * BOND);
    }

    function test_claim_rejectsWithholderInFullRound() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _toEnd();
        beacon.finalize(id);
        vm.prank(bob);
        vm.expectRevert(RandomnessBeacon.NothingToClaim.selector);
        beacon.claim(id);
    }

    function test_claim_refundsEveryoneWhenRoundNeverReachedMinimum() public {
        uint256 id = _round();
        _commit(id, alice, S_ALICE);
        _toEnd();
        beacon.finalize(id);
        vm.prank(alice);
        beacon.claim(id);
        assertEq(alice.balance, 10 ether);
    }

    function test_claim_rejectsSecondClaim() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.startPrank(alice);
        beacon.claim(id);
        vm.expectRevert(RandomnessBeacon.NothingToClaim.selector);
        beacon.claim(id);
        vm.stopPrank();
    }

    function test_claim_rejectsBeforeFinalize() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        vm.prank(alice);
        vm.expectRevert(RandomnessBeacon.NotFinalized.selector);
        beacon.claim(id);
    }

    function test_claim_rejectsAddressThatNeverCommitted() public {
        uint256 id = _twoCommitted();
        _reveal(id, alice, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.prank(carol);
        vm.expectRevert(RandomnessBeacon.NothingToClaim.selector);
        beacon.claim(id);
    }

    function test_claim_revertsWhenRecipientRefusesPaymentAndCanBeRetried() public {
        uint256 id = _round();
        RejectsEther wallet = new RejectsEther{value: BOND}(beacon);
        wallet.join(id, _hash(id, address(wallet), S_ALICE));
        _commit(id, bob, S_BOB);
        _toReveal();
        wallet.revealSecret(id, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.expectRevert(RandomnessBeacon.TransferFailed.selector);
        wallet.claim(id);
        assertEq(address(beacon).balance, 2 * BOND);

        wallet.setAccepting(true);
        wallet.claim(id);
        assertEq(address(wallet).balance, BOND);
        assertEq(address(beacon).balance, BOND);
    }

    function test_claim_cannotBeDoubleSpentByReentrancy() public {
        uint256 id = _round();
        ReentrantClaimer attacker = new ReentrantClaimer{value: BOND}(beacon);
        attacker.join(id, _hash(id, address(attacker), S_ALICE));
        _commit(id, bob, S_BOB);
        _toReveal();
        attacker.revealSecret(id, S_ALICE);
        _reveal(id, bob, S_BOB);
        beacon.finalize(id);
        vm.expectRevert(RandomnessBeacon.TransferFailed.selector);
        attacker.claim(id);
        assertEq(address(beacon).balance, 2 * BOND);
    }
}
