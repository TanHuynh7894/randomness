import { isAddress, type Address } from 'viem';

function address(name: string, value: string | undefined, problems: string[]): Address | undefined {
  if (!value) return undefined;
  if (isAddress(value)) return value;
  problems.push(`${name} is not a valid address: ${value}`);
  return undefined;
}

const problems: string[] = [];
export const config = {
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) ?? '',
  oracle: address('VITE_ORACLE_ADDRESS', import.meta.env.VITE_ORACLE_ADDRESS, problems),
  dice: address('VITE_DICE_ADDRESS', import.meta.env.VITE_DICE_ADDRESS, problems),
  beacon: address('VITE_BEACON_ADDRESS', import.meta.env.VITE_BEACON_ADDRESS, problems),
  problems,
};
