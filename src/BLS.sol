// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title BLS: signature verification on BN254, using the EVM precompiles.
/// @notice Signatures are in G1 and public keys in G2. A message has exactly one valid signature for a
///         given key, which is what makes the hash of a signature usable as randomness. An ECDSA
///         signature would not do: its signer can make many valid ones and pick.
/// @dev node/src/bls.ts implements the same rules. Changing the domain, the encoding, the attempt cap
///      or the parity rule means a new protocol version.
library BLS {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant SQRT_EXPONENT = (P + 1) / 4;
    uint256 internal constant MAX_ATTEMPTS = 128;
    string internal constant DOMAIN = "RANDOMNESS-ORACLE-BN254-G1-V1";

    // G2 generator in precompile order: x imaginary, x real, y imaginary, y real.
    uint256 private constant G2_X_IM = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 private constant G2_X_RE = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 private constant G2_Y_IM = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 private constant G2_Y_RE = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    address private constant MODEXP = address(5);
    address private constant PAIRING = address(8);

    error HashToCurveFailed();

    /// @notice Try-and-increment: the first candidate x whose x^3 + 3 is a square, with the even y.
    function hashToG1(bytes32 message) internal view returns (uint256 x, uint256 y) {
        for (uint256 attempt; attempt < MAX_ATTEMPTS; attempt++) {
            x = uint256(keccak256(abi.encodePacked(DOMAIN, message, uint8(attempt)))) % P;
            uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
            y = _sqrtCandidate(rhs);
            if (mulmod(y, y, P) == rhs) {
                return (x, y & 1 == 0 ? y : P - y);
            }
        }
        revert HashToCurveFailed();
    }

    /// @notice Checks e(signature, -G2) * e(H(message), publicKey) == 1.
    /// @dev The precompile rejects coordinates >= P and points off the curve, so a signature has one encoding.
    function verify(uint256[4] memory publicKey, bytes32 message, uint256[2] memory signature)
        internal
        view
        returns (bool)
    {
        (uint256 hx, uint256 hy) = hashToG1(message);
        uint256[12] memory input = [
            signature[0],
            signature[1],
            G2_X_IM,
            G2_X_RE,
            P - G2_Y_IM,
            P - G2_Y_RE,
            hx,
            hy,
            publicKey[0],
            publicKey[1],
            publicKey[2],
            publicKey[3]
        ];
        (bool ok, bytes memory out) = PAIRING.staticcall(abi.encodePacked(input));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    /// @notice True when the precompile accepts the key as a G2 point, and it is not infinity.
    function isValidPublicKey(uint256[4] memory publicKey) internal view returns (bool) {
        if (publicKey[0] | publicKey[1] | publicKey[2] | publicKey[3] == 0) return false;
        // The G1 point at infinity needs no pairing work, but the precompile still validates the G2 input.
        (bool ok,) = PAIRING.staticcall(abi.encode(uint256(0), uint256(0), publicKey));
        return ok;
    }

    function _sqrtCandidate(uint256 value) private view returns (uint256) {
        (bool ok, bytes memory out) = MODEXP.staticcall(abi.encode(32, 32, 32, value, SQRT_EXPONENT, P));
        require(ok);
        return abi.decode(out, (uint256));
    }
}
