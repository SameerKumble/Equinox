import { verifyMessage } from 'viem'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import type { Chain } from '../provider/types'

/* Vérifie, sur CET appareil, qu'une signature rendue par le fournisseur est bien valide pour l'adresse.
   On ne fait pas confiance au fournisseur sur parole: la preuve se contrôle avec la clé publique de l'adresse. */

export type SignatureCheck = { status: 'valid' | 'invalid' | 'unverified'; detail: string }

const valid = (detail: string): SignatureCheck => ({ status: 'valid', detail })
const invalid = (detail: string): SignatureCheck => ({ status: 'invalid', detail })
const unverified = (detail: string): SignatureCheck => ({ status: 'unverified', detail })

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))

/** Un même texte de signature peut être en hexadécimal, base64 ou base58: on essaie chaque lecture plausible. */
function candidates(sig: string): Uint8Array[] {
  const out: Uint8Array[] = []
  const s = sig.trim()
  const hex = s.replace(/^0x/, '')
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) out.push(hexToBytes(hex))
  try {
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) out.push(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
  } catch {
    /* pas du base64 */
  }
  try {
    out.push(bs58.decode(s))
  } catch {
    /* pas du base58 */
  }
  return out
}

async function checkEvm(address: string, message: string, signature: string): Promise<SignatureCheck> {
  try {
    const ok = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` })
    return ok ? valid('Valid: the signature was made by the key behind this address.') : invalid('The signature does NOT match this address.')
  } catch {
    return unverified('The signature could not be read in the expected format.')
  }
}

function checkSolana(address: string, message: string, signature: string): SignatureCheck {
  let publicKey: Uint8Array
  try {
    publicKey = bs58.decode(address)
  } catch {
    return unverified('The address could not be read.')
  }
  const bytes = new TextEncoder().encode(message)
  const sigs = candidates(signature).filter((c) => c.length === 64)
  if (sigs.length === 0) return unverified('The signature is not in a format this page can check.')
  return sigs.some((s) => nacl.sign.detached.verify(bytes, s, publicKey))
    ? valid('Valid: the signature was made by the key behind this address.')
    : invalid('The signature does NOT match this address.')
}

export async function checkSignature(chain: Chain, address: string, message: string, signature: string): Promise<SignatureCheck> {
  if (chain === 'EVM') return checkEvm(address, message, signature)
  if (chain === 'SOL') return checkSolana(address, message, signature)
  const { checkBitcoin } = await import('./bitcoin')
  return checkBitcoin(address, message, signature)
}
