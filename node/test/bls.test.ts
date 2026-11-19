import { readFileSync } from 'node:fs';
import { bn254 } from '@noble/curves/bn254.js';
import { describe, expect, it } from 'vitest';
import { hashToG1, messageFor, publicKey, sign } from '../src/bls';

const { Point: G1 } = bn254.G1;
const { Point: G2 } = bn254.G2;
const P = G1.Fp.ORDER;
const SK = 0x1234567890abcdefn;
const M = `0x${'ab'.repeat(32)}` as const;

function verifies(sk: bigint, message: `0x${string}`, sig: readonly [bigint, bigint]) {
  const [xi, xr, yi, yr] = publicKey(sk);
  const pk = G2.fromAffine({ x: { c0: xr, c1: xi }, y: { c0: yr, c1: yi } });
  const h = hashToG1(message);
  const left = bn254.pairing(G1.fromAffine({ x: sig[0], y: sig[1] }), G2.BASE);
  const right = bn254.pairing(G1.fromAffine({ x: h.x, y: h.y }), pk);
  return bn254.fields.Fp12.eql(left, right);
}

describe('hashToG1', () => {
  it('returns a point on the curve with an even y', () => {
    const { x, y } = hashToG1(M);
    expect((y * y) % P).toBe((x * x * x + 3n) % P);
    expect(y % 2n).toBe(0n);
  });

  it('is deterministic', () => {
    expect(hashToG1(M)).toEqual(hashToG1(M));
  });

  it('moves on when the first candidate is not on the curve', () => {
    const attempts = Array.from({ length: 16 }, (_, i) =>
      hashToG1(`0x${i.toString(16).padStart(64, '0')}`).attempts,
    );
    expect(Math.max(...attempts)).toBeGreaterThan(0);
  });
});

describe('sign', () => {
  it('produces a signature that passes the pairing equation', () => {
    expect(verifies(SK, M, sign(SK, M))).toBe(true);
  });

  it('does not verify under another key', () => {
    expect(verifies(SK + 1n, M, sign(SK, M))).toBe(false);
  });

  it('gives one signature per message', () => {
    expect(sign(SK, M)).toEqual(sign(SK, M));
  });

  it('rejects a zero key', () => {
    expect(() => sign(0n, M)).toThrow();
  });
});

describe('committed fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/bls.json', import.meta.url), 'utf8'));

  it('still matches this code', () => {
    const sk = BigInt(fixture.sk);
    expect(publicKey(sk).map(BigInt)).toEqual(fixture.publicKey.map(BigInt));
    for (const v of fixture.vectors) {
      expect(sign(sk, v.message)).toEqual([BigInt(v.sigX), BigInt(v.sigY)]);
    }
    expect(messageFor({ ...fixture.request, requestId: BigInt(fixture.request.requestId) })).toBe(fixture.request.message);
  });
});

describe('messageFor', () => {
  const base = {
    chainId: 43113,
    oracle: '0x00000000000000000000000000000000000000aa',
    requestId: 1n,
    consumer: '0x00000000000000000000000000000000000000bb',
    blockHash: `0x${'cd'.repeat(32)}`,
  } as const;

  it('changes with every field', () => {
    const m = messageFor(base);
    expect(messageFor({ ...base, chainId: 1 })).not.toBe(m);
    expect(messageFor({ ...base, oracle: '0x00000000000000000000000000000000000000ac' })).not.toBe(m);
    expect(messageFor({ ...base, requestId: 2n })).not.toBe(m);
    expect(messageFor({ ...base, consumer: '0x00000000000000000000000000000000000000bc' })).not.toBe(m);
    expect(messageFor({ ...base, blockHash: `0x${'ce'.repeat(32)}` })).not.toBe(m);
  });
});
