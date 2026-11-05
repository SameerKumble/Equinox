import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { b64u } from '../src/webauthn.mjs'

/* Authentificateur WebAuthn LOGICIEL pour les tests: il fabrique de vraies réponses (clé P-256 ou RSA, signatures réelles,
   structures CBOR et données d'authentificateur conformes). Le serveur les vérifie exactement comme celles d'un navigateur. */

const sha256 = (d) => createHash('sha256').update(d).digest()
const u16 = (n) => Buffer.from([n >> 8, n & 255])
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) return Buffer.concat([Buffer.from([(major << 5) | 25]), u16(n)])
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(n)])
}

export function cborEncode(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') {
    const b = Buffer.from(v)
    return Buffer.concat([head(3, b.length), b])
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)])
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])])
  if (v === true) return Buffer.from([0xf5])
  if (v === false) return Buffer.from([0xf4])
  if (v === null) return Buffer.from([0xf6])
  throw new Error('cbor: type non géré dans le test')
}

/**
 * @param origin  origine de l'application (l'identifiant de partie de confiance en est le nom d'hôte)
 * @param alg     -7 (ES256, par défaut) ou -257 (RS256)
 * @param backup  passkey synchronisé (indicateurs BE et BS)
 * @param counter true: le compteur de signatures progresse (clé matérielle); false: reste à 0 (passkey synchronisé)
 */
export function softwareAuthenticator({ origin, alg = -7, backup = false, counter = true, userHandle = null } = {}) {
  const rpId = new URL(origin).hostname
  const pair = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = pair.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32)
  const id = b64u.encode(credentialId)
  let count = 0
  const cose =
    alg === -7
      ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]])
      : new Map([[1, 3], [3, -257], [-1, b64u.decode(jwk.n)], [-2, b64u.decode(jwk.e)]])
  const flagsFor = (uv) => 0x01 | (uv === false ? 0 : 0x04) | (backup ? 0x18 : 0)
  const clientData = (type, challenge, tweak) =>
    Buffer.from(JSON.stringify({ type: tweak.type ?? type, challenge: tweak.challenge ?? challenge, origin: tweak.origin ?? origin, crossOrigin: tweak.crossOrigin ?? false }))

  return {
    id,
    rpId,
    /** `publicKey` = les options de création renvoyées par la banque. `tweak` fabrique des réponses fautives. */
    create(publicKey, tweak = {}) {
      const data = clientData('webauthn.create', publicKey.challenge, tweak)
      const authData = Buffer.concat([
        sha256(tweak.rpId ?? rpId),
        Buffer.from([flagsFor(tweak.uv) | 0x40]),
        u32(counter ? 0 : 0),
        Buffer.alloc(16),
        u16(credentialId.length),
        credentialId,
        cborEncode(tweak.cose ?? cose),
      ])
      const attestationObject = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
      return {
        id: tweak.id ?? id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON: b64u.encode(data), attestationObject: b64u.encode(tweak.attestationObject ?? attestationObject), transports: ['internal'] },
      }
    },
    /** `publicKey` = les options d'authentification renvoyées par la banque. */
    get(publicKey, tweak = {}) {
      if (counter) count += 1
      const data = clientData('webauthn.get', publicKey.challenge, tweak)
      const authData = Buffer.concat([sha256(tweak.rpId ?? rpId), Buffer.from([flagsFor(tweak.uv)]), u32(tweak.signCount ?? count)])
      const signed = Buffer.concat([authData, sha256(tweak.signedClientData ?? data)])
      const signature = sign('sha256', signed, tweak.privateKey ?? pair.privateKey)
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64u.encode(data),
          authenticatorData: b64u.encode(authData),
          signature: b64u.encode(signature),
          userHandle: tweak.noUserHandle ? undefined : (tweak.userHandle ?? userHandle) ? b64u.encode(tweak.userHandle ?? userHandle) : undefined,
        },
      }
    },
    setCounter(n) {
      count = n
    },
    /** Associe l'identifiant d'utilisateur reçu à l'inscription: un passkey « découvrable » le renvoie à la connexion. */
    rememberUser(handleB64u) {
      userHandle = b64u.decode(handleB64u)
    },
  }
}

export { generateKeyPairSync }
