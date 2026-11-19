// Prints a new BLS key as env lines. The first line is secret: redirect this into a file git ignores.
import { randomBytes } from 'node:crypto';
import { bn254 } from '@noble/curves/bn254.js';
import { toHex } from 'viem';
import { publicKey } from './bls';

const order = bn254.G1.Point.Fn.ORDER;
const sk = (BigInt(toHex(randomBytes(64))) % (order - 1n)) + 1n;

console.log(`ORACLE_BLS_KEY=${toHex(sk, { size: 32 })}`);
publicKey(sk).forEach((word, i) => console.log(`ORACLE_PK_${i}=${toHex(word, { size: 32 })}`));
