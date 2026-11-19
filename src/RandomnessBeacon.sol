// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title RandomnessBeacon: multi-party commit-reveal randomness, no external service.
/// @notice Each round: participants post a bond and commit to a secret, then reveal it. The output
///         exists only if everyone who committed revealed. Withholding fails the round and locks the
///         withheld bond in this contract forever, so an abort always costs the full bond: paying it
///         to revealers or the creator would let an attacker on several addresses recover it.
///         Withholding can only abort a round, never pick among results. The output is unpredictable
///         as long as one participant keeps their secret until the reveal phase. Consumers should
///         require a bond larger than what an abort could win.
contract RandomnessBeacon {
    enum Status { Open, Finalized, Failed }

    struct Round {
        address creator;
        uint64 commitEnd;
        uint64 revealEnd;
        uint32 minParticipants;
        uint32 commits;
        uint32 reveals;
        Status status;
        uint256 bond;
        uint256 accumulator;
        uint256 randomness;
    }

    struct Entry {
        bytes32 commitment;
        bool committed;
        bool revealed;
        bool claimed;
    }

    error BadParams();
    error WrongPhase();
    error WrongBond();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyRevealed();
    error BadReveal();
    error AlreadyFinalized();
    error NotFinalized();
    error NoRandomness();
    error NothingToClaim();
    error TransferFailed();

    event RoundCreated(uint256 indexed roundId, address indexed creator, uint64 commitEnd, uint64 revealEnd, uint256 bond);
    event Committed(uint256 indexed roundId, address indexed participant);
    event Revealed(uint256 indexed roundId, address indexed participant);
    event RoundFinalized(uint256 indexed roundId, uint256 randomness);
    event RoundFailed(uint256 indexed roundId);

    uint256 public roundCount;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Entry)) public entries;

    function createRound(uint64 commitDuration, uint64 revealDuration, uint256 bond, uint32 minParticipants)
        external
        returns (uint256 roundId)
    {
        if (commitDuration == 0 || revealDuration == 0 || bond == 0 || minParticipants < 2) revert BadParams();
        roundId = roundCount++;
        Round storage r = rounds[roundId];
        r.creator = msg.sender;
        r.commitEnd = uint64(block.timestamp) + commitDuration;
        r.revealEnd = r.commitEnd + revealDuration;
        r.bond = bond;
        r.minParticipants = minParticipants;
        emit RoundCreated(roundId, msg.sender, r.commitEnd, r.revealEnd, bond);
    }

    /// @param commitment keccak256(abi.encode(block.chainid, address(this), roundId, msg.sender, secret))
    function commit(uint256 roundId, bytes32 commitment) external payable {
        Round storage r = rounds[roundId];
        if (block.timestamp > r.commitEnd) revert WrongPhase();
        if (msg.value != r.bond) revert WrongBond();
        Entry storage e = entries[roundId][msg.sender];
        if (e.committed) revert AlreadyCommitted();
        e.committed = true;
        e.commitment = commitment;
        r.commits++;
        emit Committed(roundId, msg.sender);
    }

    function reveal(uint256 roundId, bytes32 secret) external {
        Round storage r = rounds[roundId];
        if (block.timestamp <= r.commitEnd || block.timestamp > r.revealEnd) revert WrongPhase();
        Entry storage e = entries[roundId][msg.sender];
        if (!e.committed) revert NotCommitted();
        if (e.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(block.chainid, address(this), roundId, msg.sender, secret)) != e.commitment) {
            revert BadReveal();
        }
        e.revealed = true;
        r.reveals++;
        // XOR keeps the output independent of reveal order.
        r.accumulator ^= uint256(keccak256(abi.encode(msg.sender, secret)));
        emit Revealed(roundId, msg.sender);
    }

    /// @notice Callable by anyone once all commits are revealed, or once the reveal phase has ended.
    function finalize(uint256 roundId) external {
        if (roundId >= roundCount) revert WrongPhase();
        Round storage r = rounds[roundId];
        if (r.status != Status.Open) revert AlreadyFinalized();
        if (block.timestamp <= r.commitEnd) revert WrongPhase();
        if (r.reveals != r.commits && block.timestamp <= r.revealEnd) revert WrongPhase();

        if (r.commits >= r.minParticipants && r.reveals == r.commits) {
            r.status = Status.Finalized;
            r.randomness = uint256(keccak256(abi.encode(block.chainid, address(this), roundId, r.accumulator)));
            emit RoundFinalized(roundId, r.randomness);
        } else {
            r.status = Status.Failed;
            emit RoundFailed(roundId);
        }
    }

    /// @notice Returns the bond to whoever revealed. If the round never reached its minimum, everyone gets it back.
    function claim(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status == Status.Open) revert NotFinalized();
        Entry storage e = entries[roundId][msg.sender];
        if (!e.committed || e.claimed) revert NothingToClaim();
        if (!e.revealed && r.commits >= r.minParticipants) revert NothingToClaim();

        e.claimed = true;
        (bool sent,) = msg.sender.call{value: r.bond}("");
        if (!sent) revert TransferFailed();
    }

    function randomOf(uint256 roundId) external view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.status != Status.Finalized) revert NoRandomness();
        return r.randomness;
    }

    function statusOf(uint256 roundId) external view returns (Status) {
        return rounds[roundId].status;
    }
}
