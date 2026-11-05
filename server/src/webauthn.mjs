import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

/* Vérification WebAuthn côté banque (le « Relying Party »), sans dépendance.
   Le passkey est géré par la banque: elle l'enregistre, l'exige pour se connecter et pour signer, et le retire.
   Rien ici ne fait confiance à l'attestation (on demande `none`): ce qui compte, c'est la clé publique enregistrée, puis la
   signature d'un défi frais, lié à l'origine et à l'identifiant de partie de confiance, avec vérification de l'utilisateur. */

export class WebAuthnError extends Error {
  constructor(message, code = 'invalid_credential') {
    super(message)
    this.code = code
  }
}

export const b64u = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (s) => Buffer.from(String(s ?? ''), 'base64url'),
}

const sha256 = (data) => createHash('sha256').update(data).digest()
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b)

/* ------------------------------ CBOR (sous-ensemble) ------------------------------ */
// Le CBOR de WebAuthn est canonique (longueurs définies): entiers, octets, textes, tableaux, tables, booléens, null.

const MAX_DEPTH = 8
const MAX_ITEMS = 256

function head(buf, o) {
  const first = buf[o]
  if (first === undefined) throw new WebAuthnError('CBOR truncated')
  o += 1
  const major = first >> 5
  const info = first & 31
  let n
  if (info < 24) n = info
  else if (info === 24) {
    n = buf.readUInt8(o)
    o += 1
  } else if (info === 25) {
    n = buf.readUInt16BE(o)
    o += 2
  } else if (info === 26) {
    n = buf.readUInt32BE(o)
    o += 4
  } else if (info === 27) {
    n = buf.readUInt32BE(o) * 2 ** 32 + buf.readUInt32BE(o + 4)
    o += 8
    if (!Number.isSafeInteger(n)) throw new WebAuthnError('CBOR integer too large')
  } else throw new WebAuthnError('CBOR indefinite length not supported')
  return { major, info, n, o }
}

/** Décode UN élément CBOR à partir de `offset`. Rend la valeur et la position qui suit. */
export function cborDecode(buf, offset = 0, depth = 0) {
  if (depth > MAX_DEPTH) throw new WebAuthnError('CBOR nested too deeply')
  try {
    const { major, info, n, o } = head(buf, offset)
    switch (major) {
      case 0:
        return { value: n, offset: o }
      case 1:
        return { value: -1 - n, offset: o }
      case 2:
      case 3: {
        if (o + n > buf.length) throw new WebAuthnError('CBOR truncated')
        const bytes = buf.subarray(o, o + n)
        return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), offset: o + n }
      }
      case 4: {
        if (n > MAX_ITEMS) throw new WebAuthnError('CBOR array too long')
        const out = []
        let at = o
        for (let i = 0; i < n; i++) {
          const item = cborDecode(buf, at, depth + 1)
          out.push(item.value)
          at = item.offset
        }
        return { value: out, offset: at }
      }
      case 5: {
        if (n > MAX_ITEMS) throw new WebAuthnError('CBOR map too long')
        const out = new Map()
        let at = o
        for (let i = 0; i < n; i++) {
          const k = cborDecode(buf, at, depth + 1)
          const v = cborDecode(buf, k.offset, depth + 1)
          out.set(k.value, v.value)
          at = v.offset
        }
        return { value: out, offset: at }
      }
      case 7:
        if (info === 20) return { value: false, offset: o }
        if (info === 21) return { value: true, offset: o }
        if (info === 22 || info === 23) return { value: null, offset: o }
        throw new WebAuthnError('CBOR simple value not supported')
      default:
        throw new WebAuthnError('CBOR tag not supported')
    }
  } catch (e) {
    if (e instanceof WebAuthnError) throw e
    throw new WebAuthnError('CBOR malformed')
  }
}

/* --------------------------- données de l'authentificateur --------------------------- */

export function parseAuthData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) throw new WebAuthnError('authenticator data too short')
  const flags = authData[32]
  const out = {
    rpIdHash: authData.subarray(0, 32),
    up: Boolean(flags & 0x01),
    uv: Boolean(flags & 0x04),
    backupEligible: Boolean(flags & 0x08),
    backedUp: Boolean(flags & 0x10),
    hasCredential: Boolean(flags & 0x40),
    signCount: authData.readUInt32BE(33),
  }
  if (out.hasCredential) {
    let o = 37
    if (authData.length < o + 18) throw new WebAuthnError('attested credential data too short')
    const aaguid = authData.subarray(o, o + 16)
    o += 16
    const length = authData.readUInt16BE(o)
    o += 2
    if (length < 16 || length > 1023 || authData.length < o + length) throw new WebAuthnError('credential id has an invalid length')
    const credentialId = Buffer.from(authData.subarray(o, o + length))
    o += length
    out.credential = { aaguid: Buffer.from(aaguid), credentialId, cose: cborDecode(authData, o).value }
  }
  return out
}

/** Clé COSE -> JWK. Seuls ES256 (P-256) et RS256 (RSA >= 2048 bits) sont acceptés. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new WebAuthnError('credential key is malformed')
  const kty = cose.get(1)
  const alg = cose.get(3)
  let jwk
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2)
    const y = cose.get(-3)
    if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) throw new WebAuthnError('credential key is malformed')
    jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(x), y: b64u.encode(y) }
  } else if (kty === 3 && alg === -257) {
    const n = cose.get(-1)
    const e = cose.get(-2)
    if (!Buffer.isBuffer(n) || n.length < 256 || n.length > 1024 || !Buffer.isBuffer(e) || e.length < 1 || e.length > 8) throw new WebAuthnError('credential key is malformed')
    jwk = { kty: 'RSA', n: b64u.encode(n), e: b64u.encode(e) }
  } else {
    throw new WebAuthnError('This type of passkey is not supported', 'unsupported_algorithm')
  }
  try {
    createPublicKey({ key: jwk, format: 'jwk' }) // refuse un point hors de la courbe, une clé invalide
  } catch {
    throw new WebAuthnError('credential key is invalid')
  }
  return { alg, jwk }
}

/* ------------------------------- vérifications ------------------------------- */

function clientData(raw, type, expectedChallenge, allowedOrigins) {
  const bytes = b64u.decode(raw)
  if (bytes.length === 0 || bytes.length > 4096) throw new WebAuthnError('client data has an invalid size')
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new WebAuthnError('client data is not valid JSON')
  }
  if (data?.type !== type) throw new WebAuthnError('wrong ceremony type')
  if (typeof data.challenge !== 'string' || !same(b64u.decode(data.challenge), expectedChallenge)) throw new WebAuthnError('challenge does not match')
  if (typeof data.origin !== 'string' || !allowedOrigins.includes(data.origin)) throw new WebAuthnError('origin is not allowed')
  if (data.crossOrigin === true || data.topOrigin !== undefined) throw new WebAuthnError('cross-origin ceremonies are not allowed')
  return { bytes, data }
}

function checkAuthData(auth, rpId, requireUv) {
  if (!same(auth.rpIdHash, sha256(rpId))) throw new WebAuthnError('relying party does not match')
  if (!auth.up) throw new WebAuthnError('user presence is missing')
  if (requireUv && !auth.uv) throw new WebAuthnError('user verification is missing')
}

/**
 * Inscription d'un passkey. `credential` est la réponse JSON du navigateur (navigator.credentials.create).
 * Rend ce qu'il faut stocker: identifiant, clé publique (JWK), algorithme, compteur et indicateurs de synchronisation.
 */
export function verifyRegistration({ credential, expectedChallenge, allowedOrigins, rpId, requireUv = true }) {
  if (credential?.type !== 'public-key' || typeof credential.id !== 'string') throw new WebAuthnError('not a public-key credential')
  const response = credential.response ?? {}
  clientData(response.clientDataJSON, 'webauthn.create', expectedChallenge, allowedOrigins)
  const attestation = cborDecode(b64u.decode(response.attestationObject)).value
  const authData = attestation instanceof Map ? attestation.get('authData') : null
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('attestation object is malformed')
  const auth = parseAuthData(authData)
  checkAuthData(auth, rpId, requireUv)
  if (!auth.credential) throw new WebAuthnError('no credential in the attestation')
  if (b64u.encode(auth.credential.credentialId) !== credential.id) throw new WebAuthnError('credential id does not match')
  const { alg, jwk } = coseToJwk(auth.credential.cose)
  return { credentialId: credential.id, jwk, alg, signCount: auth.signCount, backupEligible: auth.backupEligible, backedUp: auth.backedUp }
}

/**
 * Connexion ou autorisation par passkey. `stored` vient de la base: { jwk, alg, signCount }.
 * Un compteur qui ne progresse pas (quand il est utilisé) trahit un passkey cloné: refusé.
 */
export function verifyAssertion({ credential, expectedChallenge, allowedOrigins, rpId, stored, requireUv = true }) {
  if (credential?.type !== 'public-key' || typeof credential.id !== 'string') throw new WebAuthnError('not a public-key credential')
  const response = credential.response ?? {}
  const { bytes } = clientData(response.clientDataJSON, 'webauthn.get', expectedChallenge, allowedOrigins)
  const authData = b64u.decode(response.authenticatorData)
  const auth = parseAuthData(authData)
  checkAuthData(auth, rpId, requireUv)
  const signature = b64u.decode(response.signature)
  if (signature.length === 0 || signature.length > 1024) throw new WebAuthnError('signature has an invalid size')
  const signed = Buffer.concat([authData, sha256(bytes)])
  const key = createPublicKey({ key: stored.jwk, format: 'jwk' })
  const ok = stored.alg === -7 ? verify('sha256', signed, { key, dsaEncoding: 'der' }, signature) : verify('sha256', signed, key, signature)
  if (!ok) throw new WebAuthnError('signature is not valid')
  if ((auth.signCount !== 0 || stored.signCount !== 0) && auth.signCount <= stored.signCount) {
    throw new WebAuthnError('signature counter went backwards: the passkey may have been cloned', 'counter')
  }
  return { signCount: auth.signCount, backedUp: auth.backedUp, userHandle: response.userHandle ? b64u.decode(response.userHandle) : null }
}
