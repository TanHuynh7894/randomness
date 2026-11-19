import type { Address } from 'viem';
import { useApp } from '../app-context';
import { DICE_ABI } from '../chain';
import { amount } from '../format';
import { TxButton } from './common';

export function RollButton({ dice, fee }: { dice: Address; fee: bigint }) {
  const { signer, chainId, openLogin } = useApp();
  if (!signer) return <button type="button" className="button" onClick={openLogin}>SIGN IN TO ROLL</button>;
  return <TxButton label={`ROLL · ${amount(fee, chainId)}`} action={() => signer.write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: fee })} />;
}
