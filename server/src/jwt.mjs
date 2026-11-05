import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

/** Signataire RS256. La clé privée reste dans le dossier de données et n'est jamais exposée. */
export function loadSigner(dataDir, { issuer, audience, kid }) {
  mkdirSync(dataDir, { recursive: true })
  const keyFile = join(dataDir, 'jwt-private.pem')
  if (!existsSync(keyFile)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  }
  const privateKey = createPrivateKey(readFileSync(keyFile))
  const publicJwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }

  return {
    jwks: () => ({ keys: [publicJwk] }),
    /** @param claims champs propres au jeton (sub, email, scope...) */
    sign(claims, ttlSeconds, nowMs = Date.now()) {
      const iat = Math.floor(nowMs / 1000)
      const head = b64({ alg: 'RS256', typ: 'JWT', kid })
      const body = b64({ iss: issuer, aud: audience, iat, exp: iat + ttlSeconds, jti: randomUUID(), ...claims })
      const signature = cryptoSign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
      return `${head}.${body}.${signature}`
    },
  }
}
