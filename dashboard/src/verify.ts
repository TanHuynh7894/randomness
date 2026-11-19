// Checks an oracle answer in the browser, the way the contract does, from chain data alone.
import { bn254 } from '@noble/curves/bn254.js';
import { decodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { hashToG1, messageFor } from '../../node/src/bls';
import { ORACLE_ABI } from './chain';
import type { OracleRequest } from './derive';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;

export type Verification =
  | { kind: 'unreadable' }
  | { kind: 'checked'; message: Hex; signature: [bigint, bigint]; signatureOk: boolean; randomnessOk: boolean; ms: number };

/** e(signature, G2) == e(H(message), publicKey), the same equation the contract hands to the precompile. */
function pairingHolds(publicKey: readonly bigint[], message: Hex, signature: readonly [bigint, bigint]): boolean {
  try {
    const sig = G1.fromAffine({ x: signature[0], y: signature[1] });
    sig.assertValidity();
    const [xi, xr, yi, yr] = publicKey;
    const pk = G2.fromAffine({ x: { c0: xr, c1: xi }, y: { c0: yr, c1: yi } });
    const h = hashToG1(message);
    return bn254.fields.Fp12.eql(bn254.pairing(sig, G2.BASE), bn254.pairing(G1.fromAffine({ x: h.x, y: h.y }), pk));
  } catch {
    return false; // Not a point on the curve, which the precompile refuses too.
  }
}

/**
 * The signature is only in the transaction's calldata, so an answer sent through another contract cannot be read
 * here. That says nothing against the answer: the contract checked it either way.
 */
export async function verifyAnswer(client: PublicClient, chainId: number, oracle: Address, request: OracleRequest): Promise<Verification> {
  if (!request.answer) throw new Error('This request has no answer to check');
  const [publicKey, tx, block] = await Promise.all([
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'publicKey' }),
    client.getTransaction({ hash: request.answer.txHash }),
    client.getBlock({ blockNumber: request.requestBlock }),
  ]);
  if (tx.to?.toLowerCase() !== oracle.toLowerCase()) return { kind: 'unreadable' };

  let signature: [bigint, bigint];
  try {
    const call = decodeFunctionData({ abi: ORACLE_ABI, data: tx.input });
    if (call.functionName !== 'fulfill' || call.args[0] !== request.id) return { kind: 'unreadable' };
    signature = [call.args[1][0], call.args[1][1]];
  } catch {
    return { kind: 'unreadable' };
  }

  const started = performance.now();
  const message = messageFor({ chainId, oracle, requestId: request.id, consumer: request.consumer, blockHash: block.hash });
  const signatureOk = pairingHolds(publicKey, message, signature);
  const hashed = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256[2]' }], [signature])));
  return { kind: 'checked', message, signature, signatureOk, randomnessOk: hashed === request.answer.randomness, ms: performance.now() - started };
}
