import type { Chain } from '../provider/types'

// Labels for the locally simulated test networks.
export type NetworkName = 'Bitcoin' | 'Ethereum' | 'Solana'

export const CHAIN_META: Record<
  Chain,
  {
    network: NetworkName
    unit: string
    testnet: string
    /** Décimales affichées pour les montants. */
    digits: number
  }
> = {
  BTC: {
    network: 'Bitcoin',
    unit: 'BTC',
    testnet: 'Bitcoin testnet',
    digits: 8,
  },
  EVM: {
    network: 'Ethereum',
    unit: 'ETH',
    testnet: 'Base Sepolia',
    digits: 6,
  },
  SOL: {
    network: 'Solana',
    unit: 'SOL',
    testnet: 'Solana testnet',
    digits: 6,
  },
}

export const CHAINS: Chain[] = ['BTC', 'EVM', 'SOL']

export function chainOfNetwork(name: string): Chain | undefined {
  return CHAINS.find((c) => CHAIN_META[c].network === name)
}

/** Montant lisible: décimales utiles seulement, sans notation scientifique. */
export function formatAmount(value: number, chain: Chain): string {
  const { digits } = CHAIN_META[chain]
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') || '0' : fixed
}
