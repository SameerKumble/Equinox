import type { Chain } from './provider/types'

/* Petits utilitaires d'affichage et de saisie, sans lien avec un fournisseur. */

export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

const dateTimeFmt = new Intl.DateTimeFormat('en-CH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
export const dateTime = (ms: number) => dateTimeFmt.format(new Date(ms))

export function nameFromEmail(email: string) {
  const n = email.split('@')[0].split('+')[0].replace(/[._-]+/g, ' ').trim()
  return n ? n.replace(/\b\w/g, (c) => c.toUpperCase()) : 'You'
}

/**
 * Contrôle de FORME avant d'appeler la banque. La banque fait le contrôle complet (somme de contrôle Bitcoin et longueur
 * Solana): ce test n'est qu'une aide de saisie, jamais une garantie.
 * Réseaux de test uniquement: Bitcoin testnet (tb1…, m/n/2…), EVM, Solana.
 */
export function validateAddress(chain: Chain, address: string): boolean {
  const t = address.trim()
  if (chain === 'EVM') return /^0x[a-fA-F0-9]{40}$/.test(t)
  if (chain === 'SOL') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)
  return /^(tb1[a-z0-9]{25,60}|[mn2][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(t)
}

/** Montant saisi (virgule ou point) en texte décimal exact, ou null s'il est invalide. Jamais de notation scientifique. */
export function parseAmount(input: string): string | null {
  const t = input.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null
  return Number(t) > 0 ? t : null
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function shareOrCopy(title: string, text: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed'
}
