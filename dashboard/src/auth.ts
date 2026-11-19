// Sign-in by wallet. It proves which wallet is here, for this page. What a wallet may actually do is enforced by the
// contracts when it sends a transaction, so nothing here protects funds or hides data: everything shown is public.
import { verifyMessage, type Address, type Hex } from 'viem';

export interface Session {
  address: Address;
  chainId: number;
  message: string;
  signature: Hex;
}

const SESSION_SECONDS = 8 * 3600;
const KEY = 'randomness:session';

export function buildLoginMessage(f: { address: Address; chainId: number; host: string; nonce: string; expiresAt: number }): string {
  return [
    'Sign in to the Randomness dashboard',
    `Address: ${f.address}`,
    `Chain: ${f.chainId}`,
    `Trang: ${f.host}`,
    `Nonce: ${f.nonce}`,
    `Expires: ${f.expiresAt}`,
    'Signing this message sends no transaction and costs nothing.',
  ].join('\n');
}

const field = (message: string, name: string) => message.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

export async function verifySession(s: Session, expected: { now: number; chainId: number; host: string }): Promise<boolean> {
  const expiresAt = Number(field(s.message, 'Expires'));
  if (!(expiresAt > expected.now)) return false;
  if (field(s.message, 'Address') !== s.address) return false;
  if (field(s.message, 'Chain') !== String(expected.chainId) || s.chainId !== expected.chainId) return false;
  if (field(s.message, 'Trang') !== expected.host) return false;
  return verifyMessage({ address: s.address, message: s.message, signature: s.signature }).catch(() => false);
}

export async function signIn(signer: { address: Address; signMessage(m: string): Promise<Hex> }, chainId: number): Promise<Session> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const message = buildLoginMessage({ address: signer.address, chainId, host: location.host, nonce, expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
  const session: Session = { address: signer.address, chainId, message, signature: await signer.signMessage(message) };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage may be off. The session still lasts until the page reloads.
  }
  return session;
}

export function storedSession(): Session | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored, then.
  }
}
