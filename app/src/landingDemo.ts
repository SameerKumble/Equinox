import type { Chain } from './provider/types'
import { validateAddress } from './util'

/* Illustration de la page d'accueil, pas le contrôle réel. Elle montre les limites de transfert par défaut. */

const LIMITS: Record<Chain, { perTx: number; perDay: number }> = {
  BTC: { perTx: 0.01, perDay: 0.05 },
  EVM: { perTx: 1, perDay: 5 },
  SOL: { perTx: 10, perDay: 50 },
}

export type DemoVerdict = { allowed: boolean; reasons: string[] }

export function demoVerdict(chain: Chain, to: string, amount: number): DemoVerdict {
  const reasons: string[] = []
  if (!validateAddress(chain, to)) reasons.push('Enter a valid test-network address')
  if (!(amount > 0)) reasons.push('Enter an amount above zero')
  else if (amount > LIMITS[chain].perTx) reasons.push(`Limit per transfer exceeded (${amount} > ${LIMITS[chain].perTx} ${chain})`)
  return reasons.length ? { allowed: false, reasons } : { allowed: true, reasons: ['Within your transfer limit'] }
}
