import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { checkSignature } from './verify'
import { checkBitcoin } from './bitcoin'

/* Les vecteurs BIP-322 viennent de la spécification: l'adresse bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l,
   la clé est publique dans l'exemple de la BIP. Notre vérificateur doit les accepter et refuser tout le reste. */
const BIP322_ADDRESS = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
const BIP322_EMPTY = 'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='
const BIP322_HELLO = 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='

describe('Bitcoin, BIP-322', () => {
  it('accepte les vecteurs de la spécification', async () => {
    expect((await checkBitcoin(BIP322_ADDRESS, '', BIP322_EMPTY)).status).toBe('valid')
    expect((await checkBitcoin(BIP322_ADDRESS, 'Hello World', BIP322_HELLO)).status).toBe('valid')
  })
  it('refuse un autre message, une autre adresse, une signature altérée', async () => {
    expect((await checkBitcoin(BIP322_ADDRESS, 'Hello World!', BIP322_HELLO)).status).toBe('invalid')
    expect((await checkBitcoin(BIP322_ADDRESS, '', BIP322_HELLO)).status).toBe('invalid')
    expect((await checkBitcoin('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'Hello World', BIP322_HELLO)).status).toBe('invalid')
    const tampered = BIP322_HELLO.replace('RfIY3p7', 'RfIY3p8')
    expect((await checkBitcoin(BIP322_ADDRESS, 'Hello World', tampered)).status).not.toBe('valid')
  })
  it("ne prétend jamais avoir vérifié ce qu'il ne comprend pas", async () => {
    expect((await checkBitcoin(BIP322_ADDRESS, 'x', 'pas du base64 !')).status).toBe('unverified')
    expect((await checkBitcoin('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'x', BIP322_HELLO)).status).toBe('unverified') // pas du P2WPKH
  })
})

describe('EVM', () => {
  const account = privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
  it('accepte une vraie signature personal_sign et refuse le reste', async () => {
    const message = 'I control this address.'
    const signature = await account.signMessage({ message })
    expect((await checkSignature('EVM', account.address, message, signature)).status).toBe('valid')
    expect((await checkSignature('EVM', account.address, 'autre message', signature)).status).toBe('invalid')
    expect((await checkSignature('EVM', '0x6DB8A8CDE4fF95d95570589D850136D2B0932b1D', message, signature)).status).toBe('invalid')
    expect((await checkSignature('EVM', account.address, message, '0x1234')).status).toBe('unverified')
  })
})

describe('Solana', () => {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const address = bs58.encode(pair.publicKey)
  const message = 'I control this address.'
  const sig = nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey)
  it('accepte la signature en base58, base64 ou hexadécimal', async () => {
    const b64 = btoa(String.fromCharCode(...sig))
    const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
    for (const form of [bs58.encode(sig), b64, hex]) expect((await checkSignature('SOL', address, message, form)).status).toBe('valid')
  })
  it('refuse un autre message ou une autre adresse', async () => {
    expect((await checkSignature('SOL', address, 'autre', bs58.encode(sig))).status).toBe('invalid')
    expect((await checkSignature('SOL', 'EWdbpPpotPtJrvBms5j4cVQouo7iR5DVvJjCVL99pAWX', message, bs58.encode(sig))).status).toBe('invalid')
  })
})
