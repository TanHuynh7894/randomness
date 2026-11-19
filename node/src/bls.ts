// BLS signatures on BN254, matching src/BLS.sol. Changing anything here means a new protocol version.
import { bn254 } from '@noble/curves/bn254.js';
import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from 'viem';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;
const Fp = G1.Fp;
const P = Fp.ORDER;
const SQRT_EXPONENT = (P + 1n) / 4n;

export const DOMAIN = 'RANDOMNESS-ORACLE-BN254-G1-V1';
export const MAX_ATTEMPTS = 128;

/** G2 in EVM precompile order: x imaginary, x real, y imaginary, y real. */
export type G2Words = readonly [bigint, bigint, bigint, bigint];
export type G1Words = readonly [bigint, bigint];

export interface RequestFields {
  chainId: number;
  oracle: Address;
  requestId: bigint;
  consumer: Address;
  blockHash: Hex;
}

export function messageFor(r: RequestFields): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(r.chainId), r.oracle, r.requestId, r.consumer, r.blockHash],
    ),
  );
}

/** Try-and-increment. The message is public, so taking variable time leaks nothing. */
export function hashToG1(message: Hex): { x: bigint; y: bigint; attempts: number } {
  for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
    const x = BigInt(keccak256(encodePacked(['string', 'bytes32', 'uint8'], [DOMAIN, message, attempts]))) % P;
    const rhs = (((x * x) % P) * x + 3n) % P;
    const y = Fp.pow(rhs, SQRT_EXPONENT);
    if ((y * y) % P === rhs) return { x, y: y % 2n === 0n ? y : P - y, attempts };
  }
  throw new Error('hashToG1: no point found');
}

export function sign(sk: bigint, message: Hex): G1Words {
  const { x, y } = hashToG1(message);
  const sig = G1.fromAffine({ x, y }).multiply(sk).toAffine();
  return [sig.x, sig.y];
}

export function publicKey(sk: bigint): G2Words {
  const { x, y } = G2.BASE.multiply(sk).toAffine();
  return [x.c1, x.c0, y.c1, y.c0];
}
