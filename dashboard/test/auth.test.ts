import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildLoginMessage, verifySession } from '../src/auth';

const account = privateKeyToAccount(generatePrivateKey());
const NOW = 1_800_000_000;
const HOST = 'dash.example';

async function signed(over: Partial<Parameters<typeof buildLoginMessage>[0]> = {}) {
  const message = buildLoginMessage({ address: account.address, chainId: 43113, host: HOST, nonce: 'abc', expiresAt: NOW + 60, ...over });
  return { address: account.address, chainId: 43113, message, signature: await account.signMessage({ message }) };
}
const check = (session: Awaited<ReturnType<typeof signed>>, now = NOW) => verifySession(session, { now, chainId: 43113, host: HOST });

describe('verifySession', () => {
  it('accepts what the wallet signed', async () => {
    expect(await check(await signed())).toBe(true);
  });
  it('rejects an expired session', async () => {
    expect(await check(await signed(), NOW + 61)).toBe(false);
  });
  it('rejects a signature from another wallet', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const session = await signed();
    expect(await check({ ...session, signature: await other.signMessage({ message: session.message }) })).toBe(false);
  });
  it('rejects a session claiming another address', async () => {
    const session = await signed();
    expect(await check({ ...session, address: privateKeyToAccount(generatePrivateKey()).address })).toBe(false);
  });
  it('rejects a message edited after signing, such as a later expiry', async () => {
    const session = await signed();
    expect(await check({ ...session, message: session.message.replace(String(NOW + 60), String(NOW + 9999)) })).toBe(false);
  });
  it('rejects a signature made for another chain or another site', async () => {
    expect(await check(await signed({ chainId: 1 }))).toBe(false);
    expect(await check(await signed({ host: 'evil.example' }))).toBe(false);
  });
  it('rejects garbage without throwing', async () => {
    expect(await check({ address: account.address, chainId: 43113, message: 'x', signature: '0x12' })).toBe(false);
  });
});
