import { createContext, useContext } from 'react';
import type { Address, PublicClient } from 'viem';
import type { Session } from './auth';
import type { BeaconSnapshot, OracleSnapshot, Signer, Wallet } from './chain';

export interface AppState {
  client: PublicClient;
  rpcUrl: string;
  chainId?: number;
  nowSec: number;
  oracle?: Address;
  dice?: Address;
  beacon?: Address;
  oracleData?: OracleSnapshot;
  oracleError?: unknown;
  beaconData?: BeaconSnapshot;
  beaconError?: unknown;
  /** Reads the chain again now, after something was sent. */
  refresh(): void;
  /** Undefined while still looking, null when this browser has no way to sign. */
  wallet?: Wallet | null;
  session: Session | null;
  signer: Signer | null;
  /** Whether the signed-in wallet is the oracle's operator. The contract fixes that address at deployment. */
  isOperator: boolean;
  openLogin(): void;
  logout(): void;
}

const Context = createContext<AppState | null>(null);
export const AppProvider = Context.Provider;

export function useApp(): AppState {
  const state = useContext(Context);
  if (!state) throw new Error('useApp needs AppProvider');
  return state;
}
