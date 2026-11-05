import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { b64u, cborDecode, coseToJwk, parseAuthData, verifyAssertion, verifyRegistration, WebAuthnError } from '../src/webauthn.mjs'
import { cborEncode, generateKeyPairSync, softwareAuthenticator } from './authenticator.mjs'

const ORIGIN = 'https://equinox.example'
const OTHER = 'https://evil.example'
const ALLOWED = [ORIGIN, 'http://localhost:5173']
const challenge = () => randomBytes(32)

/** Une inscription réussie: rend l'authentificateur et ce que la banque stockerait. */
function enrol(opts = {}) {
  const auth = softwareAuthenticator({ origin: ORIGIN, ...opts })
  const ch = challenge()
  const credential = auth.create({ challenge: b64u.encode(ch) })
  const reg = verifyRegistration({ credential, expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId })
  return { auth, reg, stored: { jwk: reg.jwk, alg: reg.alg, signCount: reg.signCount } }
}
const assert_ = (auth, stored, tweak = {}, ch = challenge(), extra = {}) =>
  verifyAssertion({ credential: auth.get({ challenge: b64u.encode(ch) }, tweak), expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId, stored, ...extra })
const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof WebAuthnError && re.test(e.message))

/* ------------------------------------ CBOR ------------------------------------ */

test('CBOR: aller-retour des types utilisés par WebAuthn, et rejet des entrées mal formées', () => {
  const value = new Map([['fmt', 'none'], [1, -7], [-2, Buffer.from([1, 2, 3])], ['liste', [1, 300, 70000, true, false, null]], ['vide', new Map()]])
  const { value: back, offset } = cborDecode(cborEncode(value))
  assert.deepEqual(back, value)
  assert.equal(offset, cborEncode(value).length)
  // Tronqué, longueur indéfinie, étiquette, flottant, imbrication excessive.
  assert.throws(() => cborDecode(cborEncode(value).subarray(0, 5)), WebAuthnError)
  assert.throws(() => cborDecode(Buffer.from([0x9f, 0x01, 0xff])), /indefinite/)
  assert.throws(() => cborDecode(Buffer.from([0xc1, 0x01])), /tag/)
  assert.throws(() => cborDecode(Buffer.from([0xf9, 0x3c, 0x00])), /simple/)
  assert.throws(() => cborDecode(Buffer.alloc(20, 0x81)), /deeply/)
  assert.throws(() => cborDecode(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff])), WebAuthnError) // octets annoncés mais absents
})

test('CBOR: on retrouve la position qui suit un élément (la clé COSE est suivie d\'extensions possibles)', () => {
  const first = cborEncode(new Map([[1, 2]]))
  const both = Buffer.concat([first, cborEncode('suite')])
  assert.equal(cborDecode(both).offset, first.length)
})

/* ------------------------------- inscription ------------------------------- */

test('inscription: un passkey ES256 est accepté, sa clé publique et ses indicateurs sont rendus', () => {
  const { auth, reg } = enrol()
  assert.equal(reg.credentialId, auth.id)
  assert.equal(reg.alg, -7)
  assert.equal(reg.jwk.kty, 'EC')
  assert.equal(reg.jwk.crv, 'P-256')
  assert.equal(reg.signCount, 0)
  assert.equal(reg.backupEligible, false)
  assert.equal(reg.backedUp, false)
})

test('inscription: un passkey RS256 est accepté; un passkey synchronisé est reconnu comme tel', () => {
  const rsa = enrol({ alg: -257 })
  assert.equal(rsa.reg.alg, -257)
  assert.equal(rsa.reg.jwk.kty, 'RSA')
  const synced = enrol({ backup: true })
  assert.equal(synced.reg.backupEligible, true)
  assert.equal(synced.reg.backedUp, true)
})

test('inscription: défi, origine, partie de confiance, vérification de l\'utilisateur et type de cérémonie sont tous contrôlés', () => {
  const run = (tweak, ch = challenge(), requireUv = true) => {
    const auth = softwareAuthenticator({ origin: ORIGIN })
    const credential = auth.create({ challenge: b64u.encode(ch) }, tweak)
    return () => verifyRegistration({ credential, expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId, requireUv })
  }
  rejects(run({ challenge: b64u.encode(randomBytes(32)) }), /challenge/)
  rejects(run({ origin: OTHER }), /origin/)
  rejects(run({ rpId: 'evil.example' }), /relying party/)
  rejects(run({ uv: false }), /user verification/)
  rejects(run({ type: 'webauthn.get' }), /ceremony/)
  rejects(run({ crossOrigin: true }), /cross-origin/)
  // Sans exigence de vérification de l'utilisateur, l'absence est tolérée (jamais le cas dans la banque).
  assert.doesNotThrow(run({ uv: false }, challenge(), false))
})

test('inscription: identifiant incohérent, attestation corrompue, algorithme non pris en charge, clé invalide', () => {
  const auth = softwareAuthenticator({ origin: ORIGIN })
  const ch = challenge()
  const go = (tweak) => () => verifyRegistration({ credential: auth.create({ challenge: b64u.encode(ch) }, tweak), expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId })
  rejects(go({ id: b64u.encode(randomBytes(32)) }), /credential id/)
  rejects(go({ attestationObject: Buffer.from('pas du cbor') }), /CBOR|malformed/)
  rejects(go({ attestationObject: cborEncode(new Map([['fmt', 'none']])) }), /malformed/)
  rejects(go({ cose: new Map([[1, 1], [3, -8], [-1, 6], [-2, randomBytes(32)]]) }), /not supported/) // EdDSA
  rejects(go({ cose: new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1), ], [-3, Buffer.alloc(32, 2)]]) }), /invalid/) // point hors de la courbe
  rejects(go({ cose: new Map([[1, 3], [3, -257], [-1, randomBytes(64)], [-2, Buffer.from([1, 0, 1])]]) }), /malformed/) // RSA trop petit
  assert.throws(() => verifyRegistration({ credential: { type: 'password', id: 'x' }, expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId }), /public-key/)
})

test('données d\'authentificateur: trop courtes ou tronquées sont refusées', () => {
  assert.throws(() => parseAuthData(Buffer.alloc(10)), /too short/)
  const withCredential = Buffer.concat([Buffer.alloc(32), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, 32])]) // annonce 32 octets d'identifiant, sans les fournir
  assert.throws(() => parseAuthData(withCredential), /invalid length/)
  assert.throws(() => coseToJwk('pas une table'), /malformed/)
})

/* ------------------------------- authentification ------------------------------- */

test('authentification: signature valide acceptée (ES256 et RS256), le compteur est rendu', () => {
  for (const alg of [-7, -257]) {
    const { auth, stored } = enrol({ alg })
    const a = assert_(auth, stored)
    assert.equal(a.signCount, 1)
    assert.equal(a.userHandle, null)
  }
})

test('authentification: l\'identifiant d\'utilisateur (passkey découvrable) est rendu', () => {
  const { auth, stored } = enrol()
  const handle = Buffer.from('acc-123')
  const ch = challenge()
  const a = verifyAssertion({ credential: auth.get({ challenge: b64u.encode(ch) }, { userHandle: handle }), expectedChallenge: ch, allowedOrigins: ALLOWED, rpId: auth.rpId, stored })
  assert.equal(a.userHandle.toString(), 'acc-123')
})

test('authentification: autre clé, données modifiées, mauvais défi, origine, partie de confiance et vérification sont refusés', () => {
  const { auth, stored } = enrol()
  const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  rejects(() => assert_(auth, stored, { privateKey: stranger.privateKey }), /signature is not valid/)
  rejects(() => assert_(auth, stored, { signedClientData: Buffer.from('autre chose') }), /signature is not valid/)
  rejects(() => assert_(auth, stored, { challenge: b64u.encode(randomBytes(32)) }), /challenge/)
  rejects(() => assert_(auth, stored, { origin: OTHER }), /origin/)
  rejects(() => assert_(auth, stored, { rpId: 'evil.example' }), /relying party/)
  rejects(() => assert_(auth, stored, { uv: false }), /user verification/)
  rejects(() => assert_(auth, stored, { type: 'webauthn.create' }), /ceremony/)
})

test('authentification: un compteur qui recule trahit un clone; un passkey synchronisé (compteur à 0) reste accepté', () => {
  const hw = enrol()
  assert.equal(assert_(hw.auth, hw.stored).signCount, 1)
  hw.stored.signCount = 5
  rejects(() => assert_(hw.auth, hw.stored, { signCount: 5 }), /cloned/) // égal: refusé
  rejects(() => assert_(hw.auth, hw.stored, { signCount: 3 }), /cloned/) // inférieur: refusé
  assert.equal(assert_(hw.auth, hw.stored, { signCount: 6 }).signCount, 6)
  const synced = enrol({ backup: true, counter: false })
  assert.equal(assert_(synced.auth, synced.stored).signCount, 0)
  assert.equal(assert_(synced.auth, synced.stored).signCount, 0)
})

test('authentification: un défi ne vaut que pour la clé du compte (une clé étrangère enregistrée ailleurs échoue)', () => {
  const a = enrol()
  const b = enrol()
  rejects(() => assert_(a.auth, b.stored), /signature is not valid/)
})
