// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {BLS} from "../src/BLS.sol";
import {IRandomnessConsumer, RandomnessOracle} from "../src/RandomnessOracle.sol";
import {DiceRoller} from "../src/examples/DiceRoller.sol";

contract Consumer is IRandomnessConsumer {
    RandomnessOracle public immutable oracle;
    uint256 public lastId;
    uint256 public lastValue;
    uint256 public calls;
    uint256 public gasSeen;

    constructor(RandomnessOracle oracle_) {
        oracle = oracle_;
    }

    function request() external payable returns (uint256) {
        return oracle.requestRandomness{value: msg.value}();
    }

    function onRandomness(uint256 requestId, uint256 randomness) external virtual {
        gasSeen = gasleft();
        lastId = requestId;
        lastValue = randomness;
        calls++;
    }

    function withdrawRefund(address payable to, uint256 amount) external {
        oracle.withdrawRefund(to, amount);
    }
}

contract RevertingConsumer is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        revert("no");
    }
}

contract GasBurner is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        while (true) {}
    }
}

contract ReturnBomb is Consumer {
    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function onRandomness(uint256, uint256) external pure override {
        assembly {
            // As large as the callback allowance can afford. Copying it back would cost the caller about the same again.
            revert(0, 250000)
        }
    }
}

contract Reenterer is Consumer {
    bytes public innerError;
    uint256 public resultSeen;
    RandomnessOracle.Status public statusSeen;
    uint256[2] private sig;

    constructor(RandomnessOracle oracle_) Consumer(oracle_) {}

    function setSig(uint256[2] memory s) external {
        sig = s;
    }

    function onRandomness(uint256 requestId, uint256) external override {
        calls++;
        statusSeen = oracle.statusOf(requestId);
        resultSeen = oracle.randomnessOf(requestId);
        try oracle.fulfill(requestId, sig) {} catch (bytes memory reason) {
            innerError = reason;
        }
    }
}

contract OracleTestBase is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant FEE = 0.01 ether;
    address payable internal constant OPERATOR = payable(address(0xA11CE));

    uint256 internal sk;
    uint256[4] internal pk;
    string internal json;
    RandomnessOracle internal oracle;

    function setUp() public virtual {
        json = vm.readFile("test/fixtures/bls.json");
        sk = vm.parseJsonUint(json, ".sk");
        for (uint256 i; i < 4; i++) {
            pk[i] = vm.parseJsonUint(json, string.concat(".publicKey[", vm.toString(i), "]"));
        }
        oracle = new RandomnessOracle(pk, OPERATOR, FEE);
        vm.roll(1000);
    }

    function _signWith(uint256 key, bytes32 message) internal view returns (uint256[2] memory sig) {
        (uint256 x, uint256 y) = BLS.hashToG1(message);
        (bool ok, bytes memory out) = address(7).staticcall(abi.encode(x, y, key));
        require(ok, "ecMul");
        (sig[0], sig[1]) = abi.decode(out, (uint256, uint256));
    }

    /// Moves `age` blocks past the request and pins the hash the contract will read.
    function _age(uint256 requestId, uint256 age) internal {
        (, uint64 requestBlock,) = oracle.requests(requestId);
        vm.setBlockhash(requestBlock, keccak256(abi.encode("block", requestBlock)));
        vm.roll(requestBlock + age);
    }

    function _signed(uint256 requestId) internal view returns (uint256[2] memory) {
        return _signWith(sk, oracle.messageOf(requestId));
    }
}

contract BLSTest is OracleTestBase {
    function _vector(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "].", field);
    }

    function test_hashToG1_matchesTheNode() public view {
        uint256 retries;
        for (uint256 i; i < 5; i++) {
            bytes32 m = vm.parseJsonBytes32(json, _vector(i, "message"));
            (uint256 x, uint256 y) = BLS.hashToG1(m);
            assertEq(x, vm.parseJsonUint(json, _vector(i, "hx")));
            assertEq(y, vm.parseJsonUint(json, _vector(i, "hy")));
            if (vm.parseJsonUint(json, _vector(i, "attempts")) > 0) retries++;
        }
        assertGt(retries, 0, "vectors must cover retries");
    }

    function test_verify_acceptsSignaturesFromTheNode() public view {
        for (uint256 i; i < 5; i++) {
            bytes32 m = vm.parseJsonBytes32(json, _vector(i, "message"));
            uint256[2] memory sig = [vm.parseJsonUint(json, _vector(i, "sigX")), vm.parseJsonUint(json, _vector(i, "sigY"))];
            assertTrue(BLS.verify(pk, m, sig));
            uint256[2] memory mine = _signWith(sk, m);
            assertEq(mine[0], sig[0]);
            assertEq(mine[1], sig[1]);
        }
    }

    function test_verify_rejectsAlteredSignatures() public view {
        bytes32 m = keccak256("m");
        uint256[2] memory sig = _signWith(sk, m);

        assertFalse(BLS.verify(pk, keccak256("other"), sig), "other message");
        assertFalse(BLS.verify(pk, m, _signWith(sk + 1, m)), "other key");
        assertFalse(BLS.verify(pk, m, [uint256(0), uint256(0)]), "infinity");
        assertFalse(BLS.verify(pk, m, [sig[0], P - sig[1]]), "negated");
        assertFalse(BLS.verify(pk, m, [sig[0] + P, sig[1]]), "non canonical x");
        assertFalse(BLS.verify(pk, m, [sig[0], sig[1] + 1]), "not on curve");
    }

    function test_messageEncoding_matchesTheNode() public view {
        bytes32 expected = keccak256(
            abi.encode(
                vm.parseJsonUint(json, ".request.chainId"),
                vm.parseJsonAddress(json, ".request.oracle"),
                vm.parseJsonUint(json, ".request.requestId"),
                vm.parseJsonAddress(json, ".request.consumer"),
                vm.parseJsonBytes32(json, ".request.blockHash")
            )
        );
        assertEq(expected, vm.parseJsonBytes32(json, ".request.message"));
    }
}

contract RandomnessOracleTest is OracleTestBase {
    Consumer internal consumer;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk);

    function setUp() public override {
        super.setUp();
        consumer = new Consumer(oracle);
        vm.deal(address(this), 10 ether);
    }

    function _request() internal returns (uint256) {
        return consumer.request{value: FEE}();
    }

    // ---- constructor

    function test_constructor_rejectsInfinityKey() public {
        uint256[4] memory zero;
        vm.expectRevert(RandomnessOracle.BadPublicKey.selector);
        new RandomnessOracle(zero, OPERATOR, FEE);
    }

    function test_constructor_rejectsKeyNotOnCurve() public {
        uint256[4] memory bad = pk;
        bad[0] += 1;
        vm.expectRevert(RandomnessOracle.BadPublicKey.selector);
        new RandomnessOracle(bad, OPERATOR, FEE);
    }

    function test_constructor_rejectsZeroOperator() public {
        vm.expectRevert(RandomnessOracle.BadOperator.selector);
        new RandomnessOracle(pk, payable(address(0)), FEE);
    }

    function test_publicKey_isReadable() public view {
        uint256[4] memory read = oracle.publicKey();
        for (uint256 i; i < 4; i++) assertEq(read[i], pk[i]);
    }

    // ---- request

    function test_request_rejectsWrongFee() public {
        vm.expectRevert(RandomnessOracle.WrongFee.selector);
        consumer.request{value: FEE - 1}();
        vm.expectRevert(RandomnessOracle.WrongFee.selector);
        consumer.request{value: FEE + 1}();
    }

    function test_request_recordsAndEmits() public {
        vm.expectEmit(true, true, false, false);
        emit RandomnessRequested(1, address(consumer));
        uint256 id = _request();

        assertEq(id, 1);
        assertEq(_request(), 2);
        (address who, uint64 requestBlock, RandomnessOracle.Status status) = oracle.requests(id);
        assertEq(who, address(consumer));
        assertEq(requestBlock, block.number);
        assertEq(uint8(status), uint8(RandomnessOracle.Status.Pending));
    }

    // ---- fulfil

    function test_fulfill_recordsAndCallsBack() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 expected = uint256(keccak256(abi.encode(sig)));

        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, expected, true);
        oracle.fulfill(id, sig);

        assertEq(oracle.randomnessOf(id), expected);
        assertEq(consumer.lastId(), id);
        assertEq(consumer.lastValue(), expected);
        assertEq(consumer.calls(), 1);
        assertEq(oracle.earned(), FEE);
    }

    function test_fulfill_messageBindsAllFields() public {
        uint256 id = _request();
        _age(id, 1);
        (, uint64 requestBlock,) = oracle.requests(id);
        assertEq(
            oracle.messageOf(id),
            keccak256(abi.encode(block.chainid, address(oracle), id, address(consumer), blockhash(requestBlock)))
        );
    }

    function test_fulfill_inSameBlockReverts() public {
        uint256 id = _request();
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.fulfill(id, [uint256(1), uint256(2)]);
    }

    function test_fulfill_atLastBlockOfWindowWorks() public {
        uint256 id = _request();
        _age(id, 256);
        oracle.fulfill(id, _signed(id));
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_fulfill_afterWindowReverts() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        _age(id, 257);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_rejectsSignatureForAnotherRequest() public {
        uint256 a = _request();
        uint256 b = _request();
        _age(a, 1);
        uint256[2] memory sig = _signed(a);
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(b, sig);
    }

    function test_fulfill_rejectsAnotherKey() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signWith(sk + 1, oracle.messageOf(id));
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_signatureDependsOnRequestBlockHash() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        (, uint64 requestBlock,) = oracle.requests(id);
        vm.setBlockhash(requestBlock, keccak256("reorged"));
        vm.expectRevert(RandomnessOracle.BadSignature.selector);
        oracle.fulfill(id, sig);
    }

    function test_fulfill_replayReverts() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        oracle.fulfill(id, sig);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(id, sig);
        assertEq(oracle.earned(), FEE);
    }

    function test_fulfill_unknownRequestReverts() public {
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(99, [uint256(1), uint256(2)]);
    }

    function test_fulfill_isPermissionless() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        vm.prank(address(0xbeef));
        oracle.fulfill(id, sig);
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_randomnessOf_revertsUntilFulfilled() public {
        uint256 id = _request();
        vm.expectRevert(RandomnessOracle.NotFulfilled.selector);
        oracle.randomnessOf(id);
    }

    // ---- hostile consumers

    function _fulfillHostile(Consumer c) internal returns (uint256 id) {
        id = c.request{value: FEE}();
        _age(id, 1);
        oracle.fulfill(id, _signed(id));
        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
    }

    function test_revertingCallback_stillRecords() public {
        Consumer c = new RevertingConsumer(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, uint256(keccak256(abi.encode(sig))), false);
        oracle.fulfill(id, sig);
    }

    function test_gasBurningCallback_stillRecords() public {
        _fulfillHostile(new GasBurner(oracle));
    }

    function _gasToFulfil(Consumer c) internal returns (uint256 used) {
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 before = gasleft();
        oracle.fulfill(id, sig);
        used = before - gasleft();
    }

    function test_returnBomb_doesNotCostTheFulfiller() public {
        uint256 baseline = _gasToFulfil(new RevertingConsumer(oracle));
        uint256 bomb = _gasToFulfil(new ReturnBomb(oracle));
        assertGt(bomb, baseline + 100_000, "the bomb must really spend gas in the callee");
        assertLt(bomb, baseline + oracle.CALLBACK_GAS() + 5_000, "return data must not be copied");
    }

    function test_reentrantCallback_seesFinalStateAndCannotFulfilTwice() public {
        Reenterer c = new Reenterer(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        c.setSig(sig);
        vm.expectEmit(true, false, false, true);
        emit RandomnessFulfilled(id, uint256(keccak256(abi.encode(sig))), true);
        oracle.fulfill(id, sig);

        assertEq(uint8(c.statusSeen()), uint8(RandomnessOracle.Status.Fulfilled));
        assertEq(c.resultSeen(), uint256(keccak256(abi.encode(sig))));
        assertEq(bytes4(c.innerError()), RandomnessOracle.NotPending.selector);
        assertEq(c.calls(), 1);
        assertEq(oracle.earned(), FEE);
    }

    // ---- gas griefing: a submitter must not be able to make a callback fail by sending too little gas.

    function _succeedsWith(uint256 g, uint256 id, uint256[2] memory sig) internal returns (bool ok, uint256 seen) {
        uint256 snap = vm.snapshotState();
        (ok,) = address(oracle).call{gas: g}(abi.encodeCall(oracle.fulfill, (id, sig)));
        seen = consumer.gasSeen();
        vm.revertToState(snap);
    }

    function test_gas_everySuccessGivesTheCallbackItsFullAllowance() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        uint256 allowance = oracle.CALLBACK_GAS();

        // Binary search for the smallest gas that succeeds, then check every value just above it.
        uint256 low = 100_000;
        uint256 high = 1_000_000;
        (bool lowOk,) = _succeedsWith(low, id, sig);
        (bool highOk,) = _succeedsWith(high, id, sig);
        assertFalse(lowOk);
        assertTrue(highOk);
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            (bool ok,) = _succeedsWith(mid, id, sig);
            if (ok) high = mid;
            else low = mid;
        }
        for (uint256 g = high; g < high + 6_000; g += 37) {
            (bool ok, uint256 seen) = _succeedsWith(g, id, sig);
            assertTrue(ok);
            assertGe(seen + 500, allowance, "callback was short of gas");
        }
    }

    function test_gas_aBurningCallbackNeverRollsBackASuccess() public {
        Consumer c = new GasBurner(oracle);
        uint256 id = c.request{value: FEE}();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);

        uint256 successes;
        for (uint256 g = 150_000; g < 700_000; g += 1_111) {
            uint256 snap = vm.snapshotState();
            try oracle.fulfill{gas: g}(id, sig) {
                successes++;
                assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Fulfilled));
                assertEq(oracle.earned(), FEE);
            } catch {
                assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Pending));
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
    }

    function test_gas_tooLittleRevertsWithAClearError() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        // Enough for the signature check, not for the callback allowance.
        (bool ok, bytes memory out) = address(oracle).call{gas: 300_000}(abi.encodeCall(oracle.fulfill, (id, sig)));
        assertFalse(ok);
        assertEq(bytes4(out), RandomnessOracle.NotEnoughGas.selector);
    }

    // ---- expiry and refunds

    function test_expire_tooEarlyReverts() public {
        uint256 id = _request();
        _age(id, 256);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        oracle.expire(id);
    }

    function test_expire_creditsConsumerAndBlocksFulfil() public {
        uint256 id = _request();
        _age(id, 1);
        uint256[2] memory sig = _signed(id);
        _age(id, 257);
        oracle.expire(id);

        assertEq(uint8(oracle.statusOf(id)), uint8(RandomnessOracle.Status.Expired));
        assertEq(oracle.refunds(address(consumer)), FEE);
        assertEq(oracle.earned(), 0);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.fulfill(id, sig);
        vm.expectRevert(RandomnessOracle.NotPending.selector);
        oracle.expire(id);
    }

    function test_expire_worksForConsumerThatCannotReceive() public {
        // Consumer has no receive function; expiry must not depend on it.
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);
        assertEq(oracle.refunds(address(consumer)), FEE);
    }

    function test_withdrawRefund_paysChosenRecipientOnce() public {
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);

        address payable to = payable(address(0xabc));
        consumer.withdrawRefund(to, FEE);
        assertEq(to.balance, FEE);
        assertEq(oracle.refunds(address(consumer)), 0);

        vm.expectRevert(RandomnessOracle.NothingToWithdraw.selector);
        consumer.withdrawRefund(to, 1);
    }

    function test_withdrawRefund_failedTransferReverts() public {
        uint256 id = _request();
        _age(id, 257);
        oracle.expire(id);
        vm.expectRevert(RandomnessOracle.TransferFailed.selector);
        consumer.withdrawRefund(payable(address(consumer)), FEE);
        assertEq(oracle.refunds(address(consumer)), FEE);
    }

    // ---- operator fees

    function test_withdraw_paysOnlyEarnedFees() public {
        uint256 done = _request();
        _request();
        _age(done, 1);
        oracle.fulfill(done, _signed(done));

        oracle.withdraw();
        assertEq(OPERATOR.balance, FEE);
        assertEq(oracle.earned(), 0);
        assertEq(address(oracle).balance, FEE, "pending fee stays");

        vm.expectRevert(RandomnessOracle.NothingToWithdraw.selector);
        oracle.withdraw();
    }

    function test_funds_areConserved() public {
        uint256 a = _request();
        uint256 b = _request();
        uint256 c = _request();
        _age(a, 1);
        oracle.fulfill(a, _signed(a));
        _age(b, 257);
        oracle.expire(b);

        assertEq(address(oracle).balance, oracle.earned() + oracle.refunds(address(consumer)) + FEE);
        assertEq(uint8(oracle.statusOf(c)), uint8(RandomnessOracle.Status.Pending));
    }
}

contract DiceRollerTest is OracleTestBase {
    DiceRoller internal dice;
    address internal constant PLAYER = address(0x1234);

    function setUp() public override {
        super.setUp();
        dice = new DiceRoller(oracle);
        vm.deal(PLAYER, 1 ether);
    }

    function _roll() internal returns (uint256) {
        vm.prank(PLAYER);
        return dice.roll{value: FEE}();
    }

    function test_callbackSettlesARollFromOneToSix() public {
        for (uint256 i; i < 12; i++) {
            uint256 id = _roll();
            _age(id, 1);
            oracle.fulfill(id, _signed(id));
            (address player, uint8 result,) = dice.rolls(id);
            assertEq(player, PLAYER);
            assertGe(result, 1);
            assertLe(result, 6);
            assertEq(result, oracle.randomnessOf(id) % 6 + 1);
        }
    }

    function test_onlyOracleCanCallBack() public {
        uint256 id = _roll();
        vm.expectRevert(DiceRoller.NotOracle.selector);
        dice.onRandomness(id, 5);
    }

    function test_settle_recoversWhenTheCallbackFailed() public {
        uint256 id = _roll();
        _age(id, 1);
        vm.mockCallRevert(address(dice), abi.encodeWithSelector(dice.onRandomness.selector), "paused");
        oracle.fulfill(id, _signed(id));
        vm.clearMockedCalls();

        (, uint8 before,) = dice.rolls(id);
        assertEq(before, 0);

        vm.prank(address(0xbeef));
        dice.settle(id);
        (, uint8 result,) = dice.rolls(id);
        assertEq(result, oracle.randomnessOf(id) % 6 + 1);
    }

    function test_settle_isIdempotent() public {
        uint256 id = _roll();
        _age(id, 1);
        oracle.fulfill(id, _signed(id));
        (, uint8 first,) = dice.rolls(id);
        vm.recordLogs();
        dice.settle(id);
        (, uint8 second,) = dice.rolls(id);
        assertEq(first, second);
        assertEq(vm.getRecordedLogs().length, 0, "already settled");
    }

    function test_settle_revertsBeforeFulfilment() public {
        uint256 id = _roll();
        vm.expectRevert(RandomnessOracle.NotFulfilled.selector);
        dice.settle(id);
    }

    function test_refund_afterExpiryPaysThePlayerOnce() public {
        uint256 id = _roll();
        uint256 before = PLAYER.balance;
        _age(id, 257);
        vm.prank(address(0xbeef));
        dice.refund(id);
        assertEq(PLAYER.balance, before + FEE);

        vm.expectRevert(DiceRoller.NotRefundable.selector);
        dice.refund(id);
    }

    function test_refund_beforeExpiryReverts() public {
        uint256 id = _roll();
        _age(id, 256);
        vm.expectRevert(RandomnessOracle.OutsideWindow.selector);
        dice.refund(id);
    }

    function test_refund_afterFulfilmentReverts() public {
        uint256 id = _roll();
        _age(id, 1);
        oracle.fulfill(id, _signed(id));
        vm.expectRevert(DiceRoller.NotRefundable.selector);
        dice.refund(id);
    }

    function test_refund_unknownRollReverts() public {
        vm.expectRevert(DiceRoller.NotRefundable.selector);
        dice.refund(99);
    }

    function test_expiredRollLeavesNoResult() public {
        uint256 id = _roll();
        _age(id, 257);
        dice.refund(id);
        (, uint8 result, bool refunded) = dice.rolls(id);
        assertEq(result, 0);
        assertTrue(refunded);
    }
}
