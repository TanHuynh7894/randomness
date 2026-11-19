// Writes the vectors the Solidity tests check, so both implementations must agree.
import { writeFileSync } from 'node:fs';
import { toHex, type Hex } from 'viem';
import { hashToG1, messageFor, publicKey, sign } from '../src/bls';

const SK = 0x1234567890abcdefn;
const hex = (v: bigint) => toHex(v, { size: 32 });

// One message for each attempt count, so the vectors cover the retry path.
const found = new Map<number, Hex>();
for (let i = 0n; found.size < 5 && i < 2000n; i++) {
  const m = toHex(i, { size: 32 });
  const { attempts } = hashToG1(m);
  if (!found.has(attempts)) found.set(attempts, m);
}
const messages = [...found.entries()].sort(([a], [b]) => a - b).map(([, m]) => m);

const request = {
  chainId: 31337,
  oracle: '0x00000000000000000000000000000000000000aa',
  requestId: 7n,
  consumer: '0x00000000000000000000000000000000000000bb',
  blockHash: `0x${'cd'.repeat(32)}`,
} as const;

writeFileSync(
  new URL('../../test/fixtures/bls.json', import.meta.url),
  JSON.stringify(
    {
      sk: hex(SK),
      publicKey: publicKey(SK).map(hex),
      request: { ...request, requestId: hex(request.requestId), message: messageFor(request) },
      vectors: messages.map((message) => {
        const h = hashToG1(message);
        const sig = sign(SK, message);
        return { message, attempts: h.attempts, hx: hex(h.x), hy: hex(h.y), sigX: hex(sig[0]), sigY: hex(sig[1]) };
      }),
    },
    null,
    2,
  ) + '\n',
);
