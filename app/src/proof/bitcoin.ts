import { Transaction, address as btcAddress, opcodes, script } from 'bitcoinjs-lib'
import { secp256k1 } from '@noble/curves/secp256k1'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { SignatureCheck } from './verify'

/* Vérification d'une signature Bitcoin de message pour une adresse P2WPKH de testnet (tb1q…).
   Deux formats existent: BIP-322 (« simple », une pile de témoin en base64) et l'ancien format « Bitcoin Signed Message »
   (65 octets récupérables). On reconnaît le format puis on contrôle contre la clé publique de l'adresse. */

const valid = (detail: string): SignatureCheck => ({ status: 'valid', detail })
const invalid = (detail: string): SignatureCheck => ({ status: 'invalid', detail })
const unverified = (detail: string): SignatureCheck => ({ status: 'unverified', detail })

const hash160 = (b: Uint8Array) => ripemd160(sha256(b))
const sha256d = (b: Uint8Array) => sha256(sha256(b))
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

const varint = (n: number): Uint8Array => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8))

function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Programme de témoin (20 octets) d'une adresse tb1q… ou bc1q…, ou null si ce n'est pas du P2WPKH. */
function p2wpkhProgram(addr: string): Uint8Array | null {
  try {
    const d = btcAddress.fromBech32(addr)
    return d.version === 0 && d.data.length === 20 ? Uint8Array.from(d.data) : null
  } catch {
    return null
  }
}

/* ------------------------------ BIP-322 simple ------------------------------ */

function readWitness(bytes: Uint8Array): Uint8Array[] | null {
  let i = 0
  const readVar = (): number | null => {
    const first = bytes[i++]
    if (first === undefined) return null
    if (first < 0xfd) return first
    if (first === 0xfd && i + 2 <= bytes.length) {
      const n = bytes[i] | (bytes[i + 1] << 8)
      i += 2
      return n
    }
    return null
  }
  const count = readVar()
  if (count === null || count > 8) return null
  const items: Uint8Array[] = []
  for (let k = 0; k < count; k++) {
    const len = readVar()
    if (len === null || i + len > bytes.length) return null
    items.push(bytes.slice(i, i + len))
    i += len
  }
  return i === bytes.length ? items : null
}

/** Hachage « étiqueté » de la BIP-340/322: sha256(sha256(étiquette) || sha256(étiquette) || données). */
const taggedHash = (tag: string, data: Uint8Array) => {
  const t = sha256(new TextEncoder().encode(tag))
  return sha256(concat(t, t, data))
}

export function bip322SighashP2wpkh(message: string, program: Uint8Array, hashType: number): Uint8Array {
  const messageHash = taggedHash('BIP0322-signed-message', new TextEncoder().encode(message))
  const scriptPubKey = script.compile([opcodes.OP_0, Buffer.from(program)])

  // to_spend: consomme rien (txid nul), son script de dépense engage le message.
  const toSpend = new Transaction()
  toSpend.version = 0
  toSpend.locktime = 0
  toSpend.addInput(Buffer.alloc(32), 0xffffffff, 0, script.compile([opcodes.OP_0, Buffer.from(messageHash)]))
  toSpend.addOutput(Buffer.from(scriptPubKey), 0n)

  // to_sign: dépense la sortie 0 de to_spend vers un OP_RETURN. C'est la signature de CETTE transaction qui prouve la clé.
  const toSign = new Transaction()
  toSign.version = 0
  toSign.locktime = 0
  toSign.addInput(toSpend.getHash(), 0, 0)
  toSign.addOutput(script.compile([opcodes.OP_RETURN]), 0n)

  const scriptCode = script.compile([opcodes.OP_DUP, opcodes.OP_HASH160, Buffer.from(program), opcodes.OP_EQUALVERIFY, opcodes.OP_CHECKSIG])
  return Uint8Array.from(toSign.hashForWitnessV0(0, scriptCode, 0n, hashType))
}

function checkBip322(program: Uint8Array, message: string, witness: Uint8Array[]): SignatureCheck {
  if (witness.length !== 2) return unverified('The BIP-322 signature has an unexpected shape.')
  const [sigWithType, pubkey] = witness
  if (sigWithType.length < 9 || pubkey.length !== 33) return unverified('The BIP-322 signature has an unexpected shape.')
  if (!equal(hash160(pubkey), program)) return invalid('The public key in the signature does NOT belong to this address.')
  const hashType = sigWithType[sigWithType.length - 1]
  try {
    const sig = secp256k1.Signature.fromDER(sigWithType.slice(0, -1))
    const ok = secp256k1.verify(sig.toCompactRawBytes(), bip322SighashP2wpkh(message, program, hashType), pubkey, { lowS: false, prehash: false })
    return ok ? valid('Valid (BIP-322): the signature was made by the key behind this address.') : invalid('The signature does NOT match this address.')
  } catch {
    return unverified('The BIP-322 signature could not be read.')
  }
}

/* ------------------------- ancien format (65 octets) ------------------------- */

const MAGIC = new TextEncoder().encode('\x18Bitcoin Signed Message:\n')

function checkLegacy(program: Uint8Array, message: string, raw: Uint8Array): SignatureCheck {
  const header = raw[0]
  if (header < 27 || header > 42) return unverified('The signature is not in a format this page can check.')
  const msg = new TextEncoder().encode(message)
  const digest = sha256d(concat(MAGIC, varint(msg.length), msg))
  try {
    const sig = secp256k1.Signature.fromCompact(raw.slice(1)).addRecoveryBit((header - 27) & 3)
    const pubkey = sig.recoverPublicKey(digest).toRawBytes(true)
    return equal(hash160(pubkey), program)
      ? valid('Valid (signed message): the signature was made by the key behind this address.')
      : invalid('The signature does NOT match this address.')
  } catch {
    return unverified('The signature could not be read.')
  }
}

export async function checkBitcoin(address: string, message: string, signature: string): Promise<SignatureCheck> {
  const program = p2wpkhProgram(address)
  if (!program) return unverified('Only native segwit (tb1q…) addresses can be checked on this page.')
  const raw = fromBase64(signature)
  if (!raw) return unverified('The signature is not in a format this page can check.')
  const witness = readWitness(raw)
  if (witness && witness.length === 2) return checkBip322(program, message, witness)
  if (raw.length === 65) return checkLegacy(program, message, raw)
  return unverified('The signature is not in a format this page can check.')
}
