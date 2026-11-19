// Beacon secrets. Losing one before revealing loses the bond, so it is written down before the commit is sent.
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';

export const newSecret = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** What RandomnessBeacon.commit documents. */
export const commitmentFor = (chainId: number, beacon: Address, roundId: bigint, participant: Address, secret: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(chainId), beacon, roundId, participant, secret],
    ),
  );

const key = (chainId: number, beacon: Address, roundId: bigint, who: Address) => `randomness:secret:${chainId}:${beacon}:${roundId}:${who}`.toLowerCase();

export function storedSecret(chainId: number, beacon: Address, roundId: bigint, who: Address): Hex | null {
  try {
    return localStorage.getItem(key(chainId, beacon, roundId, who)) as Hex | null;
  } catch {
    return null;
  }
}

/** Keeps an existing secret: a retried commit must not swap the secret behind one that may have gone through. */
export function secretForCommit(chainId: number, beacon: Address, roundId: bigint, who: Address): { secret: Hex; saved: boolean } {
  const existing = storedSecret(chainId, beacon, roundId, who);
  if (existing) return { secret: existing, saved: true };
  const secret = newSecret();
  try {
    localStorage.setItem(key(chainId, beacon, roundId, who), secret);
    return { secret, saved: true };
  } catch {
    return { secret, saved: false };
  }
}
