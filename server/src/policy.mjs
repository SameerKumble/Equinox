import { canonicalBtc, isSolanaAddress, isTestnetBtcAddress } from './btc.mjs'

export const CHAINS = ['BTC', 'EVM', 'SOL']

// Formats d'adresses acceptés: réseaux de TEST uniquement (Bitcoin testnet, EVM, Solana).
const ADDRESS = {
  BTC: /^(tb1[a-z0-9]{25,60}|[mn2][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  EVM: /^0x[a-fA-F0-9]{40}$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
}
// Le format ne suffit pas pour Bitcoin et Solana: on vérifie aussi la somme de contrôle / la longueur, pour qu'une faute
// de frappe soit refusée ici plutôt que d'envoyer des fonds vers une adresse qui n'existe pas.
const STRICT = { BTC: isTestnetBtcAddress, SOL: isSolanaAddress }
export const isValidAddress = (chain, address) => typeof address === 'string' && !!ADDRESS[chain]?.test(address) && (STRICT[chain]?.(address) ?? true)

export function normalizeAddress(chain, address) {
  if (chain === 'EVM') return address.toLowerCase()
  if (chain === 'BTC') return canonicalBtc(address)
  return address
}

export const defaultPolicy = () => ({
  maxPerTx: { BTC: 0.01, EVM: 1, SOL: 10 },
  maxPerDay: { BTC: 0.05, EVM: 5, SOL: 50 },
  allowlist: { BTC: [], EVM: [], SOL: [] },
  blockUnknownDestinations: false,
})

export class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.code = 'invalid_policy'
  }
}

const num = (v, label) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PolicyError(`${label} must be a number of zero or more`)
  return v
}

/** Valide et normalise une politique reçue du client. */
export function validatePolicy(input) {
  if (!input || typeof input !== 'object') throw new PolicyError('Policy must be an object')
  const out = defaultPolicy()
  for (const c of CHAINS) {
    out.maxPerTx[c] = num(input.maxPerTx?.[c], `Limit per transfer (${c})`)
    out.maxPerDay[c] = num(input.maxPerDay?.[c], `Limit per day (${c})`)
    const list = input.allowlist?.[c] ?? []
    if (!Array.isArray(list) || list.length > 200) throw new PolicyError(`Approved addresses (${c}) must be a list of at most 200 entries`)
    out.allowlist[c] = list.map((a) => {
      if (!isValidAddress(c, a)) throw new PolicyError(`"${String(a).slice(0, 60)}" is not a valid ${c} test-network address`)
      return normalizeAddress(c, a)
    })
  }
  out.blockUnknownDestinations = input.blockUnknownDestinations === true
  return out
}

/** Décision de la banque sur un transfert. Elle peut refuser, jamais initier ni signer. */
export function evaluate(policy, { chain, to, amount }, spentToday) {
  const reasons = []
  if (amount > policy.maxPerTx[chain]) reasons.push(`Limit per transfer exceeded (${amount} > ${policy.maxPerTx[chain]} ${chain})`)
  if (spentToday + amount > policy.maxPerDay[chain]) {
    reasons.push(`Daily limit exceeded (${round(spentToday + amount)} > ${policy.maxPerDay[chain]} ${chain} over 24 h)`)
  }
  if (policy.blockUnknownDestinations && !policy.allowlist[chain].includes(normalizeAddress(chain, to))) {
    reasons.push('Address is not on your approved list')
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true, reasons: ['Within your limits'] }
}

const round = (n) => Math.round(n * 1e8) / 1e8
