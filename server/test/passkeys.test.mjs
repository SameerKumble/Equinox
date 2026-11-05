import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b64u } from '../src/webauthn.mjs'
import { softwareAuthenticator } from './authenticator.mjs'
import { CLEAN, Client, ORIGIN, signedUp, startFixture, verifyJwt } from './helpers.mjs'

const EMAIL = 'client@example.ch'
const PASSWORD = 'a long enough password'

/** Inscrit un passkey (cérémonie complète) pour la session `c`. Rend l'authentificateur. */
async function enrol(c, { auth = softwareAuthenticator({ origin: ORIGIN }), label = 'Test passkey', password } = {}) {
  const opts = await c.post('/api/passkeys/register/options', { password })
  assert.equal(opts.status, 200, JSON.stringify(opts.json))
  auth.rememberUser(opts.json.publicKey.user.id)
  const done = await c.post('/api/passkeys/register/verify', { challengeId: opts.json.challengeId, credential: auth.create(opts.json.publicKey), label })
  assert.equal(done.status, 200, JSON.stringify(done.json))
  return { auth, opts: opts.json, passkey: done.json.passkey }
}
/** Connexion au compte par mot de passe sur un nouveau « navigateur ». */
async function login(fx) {
  const c = new Client(fx.api)
  assert.equal((await c.post('/api/login', { email: EMAIL, password: PASSWORD })).status, 200)
  return c
}
/** Preuve de présence avec un passkey: la session devient « forte ». */
async function prove(c, auth) {
  const o = await c.post('/api/passkeys/auth/options', { purpose: 'manage' })
  assert.equal(o.status, 200, JSON.stringify(o.json))
  return c.post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: auth.get(o.json.publicKey) })
}
const mode = (r) => r.json.mode ?? r.json.status

/* ------------------------------- inscription ------------------------------- */

test('premier passkey: immédiat, exige un passkey découvrable avec vérification de l\'utilisateur, sans attestation', async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const { opts, passkey } = await enrol(c)
    assert.equal(opts.mode, 'first')
    const pk = opts.publicKey
    assert.equal(pk.rp.id, 'localhost')
    assert.equal(pk.attestation, 'none')
    assert.deepEqual(pk.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' })
    assert.deepEqual(pk.pubKeyCredParams.map((p) => p.alg), [-7, -257])
    assert.equal(pk.user.name, EMAIL)
    assert.equal(b64u.decode(pk.user.id).toString(), (await c.get('/api/me')).json.account.id, "l'identifiant d'utilisateur est celui du compte, sans donnée personnelle")
    assert.equal(b64u.decode(pk.challenge).length, 32)
    assert.equal(passkey.label, 'Test passkey')
    const list = (await c.get('/api/passkeys')).json
    assert.equal(list.passkeys.length, 1)
    assert.equal(list.strongFresh, true, "l'inscription vérifie l'utilisateur: la session devient forte")
    assert.equal((await c.get('/api/me')).json.passkeys, 1)
    const audit = (await c.get('/api/audit')).json
    assert.ok(audit.entries.some((e) => e.action === 'passkey.registered'))
    assert.ok(audit.integrity.ok)
  } finally {
    await fx.close()
  }
})

test("invite biométrique refusée au premier passkey: on peut recommencer tout de suite, sans délai ni pénalité", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    for (let i = 0; i < 5; i++) assert.equal(mode(await c.post('/api/passkeys/register/options', {})), 'first')
    await enrol(c)
  } finally {
    await fx.close()
  }
})

test("un second passkey est immédiat quand un passkey vient d'être vérifié (second appareil), sinon c'est une récupération avec délai", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const { auth } = await enrol(c)
    const second = await enrol(c, { label: 'Phone' }) // session encore forte
    assert.equal(second.opts.mode, 'proven')
    // Une session toute neuve (mot de passe seul): pas de preuve forte, donc délai de sécurité.
    const other = await login(fx)
    const pending = await other.post('/api/passkeys/register/options', {})
    assert.equal(pending.status, 202)
    assert.equal(pending.json.status, 'pending')
    assert.equal(pending.json.readyAt, fx.clock.t + 60_000)
    assert.equal(pending.json.publicKey, undefined, 'aucune option de création tant que le délai court')
    // Avec la preuve d'un passkey existant, la même session passe sans délai.
    assert.equal((await prove(other, auth)).status, 200)
    assert.equal(mode(await other.post('/api/passkeys/register/options', {})), 'proven')
    // La preuve forte expire: une nouvelle demande est une récupération (jamais « proven »). Celle de tout à l'heure a mûri pendant ce temps.
    fx.advance(11 * 60)
    const stale = await other.post('/api/passkeys/register/options', { password: PASSWORD })
    assert.equal(stale.json.mode, 'recovery')
    const cancelled = await other.post('/api/passkeys/requests/cancel', { id: pending.json.id })
    assert.equal(cancelled.status, 404, 'cette demande a déjà donné lieu à des options: elle ne peut plus être annulée')
  } finally {
    await fx.close()
  }
})

test("récupération (appareil perdu): délai de sécurité, même demande tant qu'il court, puis création possible", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await enrol(c)
    const lost = await login(fx)
    const first = await lost.post('/api/passkeys/register/options', {})
    assert.equal(first.status, 202)
    fx.advance(30)
    const again = await lost.post('/api/passkeys/register/options', {})
    assert.equal(again.json.id, first.json.id, 'la même demande, pas une nouvelle')
    fx.advance(31)
    const ready = await lost.post('/api/passkeys/register/options', {})
    assert.equal(ready.status, 200)
    assert.equal(ready.json.mode, 'recovery')
    const fresh = softwareAuthenticator({ origin: ORIGIN })
    fresh.rememberUser(ready.json.publicKey.user.id)
    const done = await lost.post('/api/passkeys/register/verify', { challengeId: ready.json.challengeId, credential: fresh.create(ready.json.publicKey), label: 'New laptop' })
    assert.equal(done.status, 200)
    assert.equal((await lost.get('/api/passkeys')).json.passkeys.length, 2)
    // Le nouveau passkey connecte: la récupération a abouti.
    const c2 = new Client(fx.api)
    const o = await c2.post('/api/passkeys/auth/options', { purpose: 'login' })
    assert.equal((await c2.post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: fresh.get(o.json.publicKey) })).status, 200)
  } finally {
    await fx.close()
  }
})

test("un attaquant avec le mot de passe volé voit sa demande en attente; le propriétaire la voit et peut l'annuler", async () => {
  const fx = await startFixture()
  try {
    const owner = await signedUp(fx)
    await enrol(owner)
    const attacker = await login(fx)
    const req = await attacker.post('/api/passkeys/register/options', {})
    assert.equal(req.status, 202)
    const seen = (await owner.get('/api/notifications')).json.pendingPasskeyRequests
    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, req.json.id)
    assert.equal(seen[0].scope, 'passkey:enroll')
    assert.equal((await owner.post('/api/passkeys/requests/cancel', { id: req.json.id })).status, 200)
    assert.equal((await owner.get('/api/notifications')).json.pendingPasskeyRequests.length, 0)
    fx.advance(120)
    assert.equal((await attacker.post('/api/passkeys/register/options', {})).status, 202, "l'annulation ne débloque rien: une nouvelle demande repart avec un nouveau délai")
    assert.equal((await owner.post('/api/passkeys/requests/cancel', { id: 'inconnu' })).status, 404)
    assert.equal((await new Client(fx.api).post('/api/passkeys/requests/cancel', { id: req.json.id })).status, 401)
  } finally {
    await fx.close()
  }
})

test("récupération: une création qui échoue peut être redemandée dans une fenêtre courte, trois fois au plus, puis le délai repart", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await enrol(c)
    const lost = await login(fx)
    const ask = () => lost.post('/api/passkeys/register/options', { password: PASSWORD })
    assert.equal((await ask()).status, 202)
    fx.advance(61)
    assert.equal((await ask()).status, 200) // essai 1 (après le délai)
    fx.advance(60)
    assert.equal((await ask()).status, 200) // essai 2: invite refusée, pas de nouveau délai
    fx.advance(60)
    assert.equal((await ask()).status, 200) // essai 3
    fx.advance(60)
    assert.equal((await ask()).status, 202, 'au-delà de trois essais, le délai repart')
  } finally {
    await fx.close()
  }
})

test("récupération: une autorisation jamais utilisée pendant plus de dix minutes est périmée (nouveau délai)", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await enrol(c)
    const lost = await login(fx)
    await lost.post('/api/passkeys/register/options', {})
    fx.advance(61)
    assert.equal((await lost.post('/api/passkeys/register/options', {})).status, 200)
    fx.advance(11 * 60)
    assert.equal((await lost.post('/api/passkeys/register/options', { password: PASSWORD })).status, 202)
  } finally {
    await fx.close()
  }
})

test("le mot de passe est redemandé quand la dernière saisie est ancienne, sauf si un passkey vient d'être vérifié", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    fx.advance(301)
    assert.equal((await c.post('/api/passkeys/register/options', {})).json.error.code, 'reauth_required')
    assert.equal((await c.post('/api/passkeys/register/options', { password: 'wrong wrong wrong' })).status, 401)
    assert.equal((await c.post('/api/passkeys/register/options', { password: PASSWORD })).status, 200)
    const { auth } = await enrol(c)
    fx.advance(400) // le mot de passe est ancien, mais un passkey vient d'être vérifié
    assert.equal((await prove(c, auth)).status, 200)
    assert.equal((await c.post('/api/passkeys/register/options', {})).status, 200)
  } finally {
    await fx.close()
  }
})

test("inscription refusée: mauvais défi, origine, partie de confiance, vérification manquante, identifiant en double; un défi ne sert qu'une fois", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const attempt = async (tweak) => {
      const o = await c.post('/api/passkeys/register/options', {})
      const auth = softwareAuthenticator({ origin: ORIGIN })
      const credential = auth.create(o.json.publicKey, tweak)
      return { o, auth, credential, res: await c.post('/api/passkeys/register/verify', { challengeId: o.json.challengeId, credential }) }
    }
    for (const tweak of [{ challenge: b64u.encode(Buffer.alloc(32, 7)) }, { origin: 'https://evil.example' }, { rpId: 'evil.example' }, { uv: false }, { type: 'webauthn.get' }]) {
      const r = await attempt(tweak)
      assert.equal(r.res.status, 401, JSON.stringify(tweak))
      assert.equal(r.res.json.error.code, 'invalid_passkey')
      // Le défi est brûlé même après un échec: on ne peut pas réessayer avec le même.
      assert.equal((await c.post('/api/passkeys/register/verify', { challengeId: r.o.json.challengeId, credential: r.auth.create(r.o.json.publicKey) })).json.error.code, 'invalid_challenge')
    }
    assert.equal((await c.get('/api/passkeys')).json.passkeys.length, 0)
    // Un passkey déjà enregistré ne l'est pas deux fois.
    const good = await attempt({})
    assert.equal(good.res.status, 200)
    const o2 = await c.post('/api/passkeys/register/options', {})
    assert.equal((await c.post('/api/passkeys/register/verify', { challengeId: o2.json.challengeId, credential: good.credential })).status, 401, 'défi différent: la signature ne correspond plus')
    // Un défi d'une autre session ne vaut rien.
    const mine = await c.post('/api/passkeys/register/options', {})
    const intruder = await login(fx)
    const stolen = softwareAuthenticator({ origin: ORIGIN })
    assert.equal((await intruder.post('/api/passkeys/register/verify', { challengeId: mine.json.challengeId, credential: stolen.create(mine.json.publicKey) })).json.error.code, 'invalid_challenge')
    // Défi périmé.
    const old = await c.post('/api/passkeys/register/options', {})
    fx.advance(6 * 60)
    assert.equal((await c.post('/api/passkeys/register/verify', { challengeId: old.json.challengeId, credential: stolen.create(old.json.publicKey) })).json.error.code, 'invalid_challenge')
    assert.equal((await new Client(fx.api).post('/api/passkeys/register/options', {})).status, 401)
  } finally {
    await fx.close()
  }
})

/* ------------------------------ connexion par passkey ------------------------------ */

test("connexion par passkey, sans mot de passe: session forte, journalisée; défi à usage unique", async () => {
  const fx = await startFixture()
  try {
    const owner = await signedUp(fx)
    const { auth, passkey } = await enrol(owner)
    const c = new Client(fx.api)
    const o = await c.post('/api/passkeys/auth/options', { purpose: 'login' })
    assert.equal(o.status, 200)
    assert.deepEqual(o.json.publicKey.allowCredentials, [], 'aucun identifiant annoncé: le compte ne fuite pas')
    assert.equal(o.json.publicKey.userVerification, 'required')
    const cred = auth.get(o.json.publicKey)
    const ok = await c.post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: cred })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.equal(ok.json.account.email, EMAIL)
    assert.match(ok.setCookie, /equinox_session=.+HttpOnly/)
    const me = (await c.get('/api/me')).json
    assert.equal(me.account.email, EMAIL)
    assert.equal(me.strongFresh, true)
    assert.equal(me.reauthFresh, true)
    assert.ok((await c.get('/api/audit')).json.entries.some((e) => e.action === 'session.passkey_login' && e.detail.label === passkey.label))
    // Rejouer la même réponse échoue: le défi est brûlé.
    assert.equal((await new Client(fx.api).post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: cred })).json.error.code, 'invalid_challenge')
  } finally {
    await fx.close()
  }
})

test("connexion par passkey refusée: compte non désigné, autre compte, passkey retiré ou inconnu, compteur qui recule, défi inconnu", async () => {
  const fx = await startFixture()
  try {
    const owner = await signedUp(fx)
    const { auth } = await enrol(owner, { auth: softwareAuthenticator({ origin: ORIGIN }) })
    await enrol(owner, { label: 'second' }) // un second passkey, pour pouvoir retirer le premier
    const tryLogin = async (tweak, cred = auth) => {
      const c = new Client(fx.api)
      const o = await c.post('/api/passkeys/auth/options', { purpose: 'login' })
      return c.post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: cred.get(o.json.publicKey, tweak) })
    }
    assert.equal((await tryLogin({ userHandle: Buffer.from('autre-compte') })).status, 401, "l'identifiant d'utilisateur doit être celui du compte")
    assert.equal((await tryLogin({ noUserHandle: true })).status, 401, "sans identifiant d'utilisateur la clé seule ne suffit pas")
    assert.equal((await tryLogin({})).status, 200)
    // Compteur qui recule: passkey cloné.
    auth.setCounter(0)
    assert.equal((await tryLogin({ signCount: 1 })).status, 401)
    assert.ok((await owner.get('/api/audit')).json.entries.some((e) => e.action === 'passkey.clone_suspected'))
    // Retiré: ne connecte plus.
    auth.setCounter(100)
    assert.equal((await prove(owner, auth)).status, 200)
    assert.equal((await owner.post('/api/passkeys/remove', { id: auth.id })).status, 200)
    assert.equal((await tryLogin({})).status, 401)
    assert.equal((await new Client(fx.api).post('/api/passkeys/auth/verify', { challengeId: 'inconnu', credential: auth.get({ challenge: 'x' }) })).json.error.code, 'invalid_challenge')
  } finally {
    await fx.close()
  }
})

test('connexion par passkey: les demandes locales ne sont pas bornées par minute', async () => {
  const fx = await startFixture()
  try {
    const c = new Client(fx.api)
    for (let i = 0; i < 25; i++) assert.equal((await c.post('/api/passkeys/auth/options', { purpose: 'login' })).status, 200)
  } finally {
    await fx.close()
  }
})

/* ------------------------------------ retrait ------------------------------------ */

test("retirer un passkey: preuve forte exigée, il en reste toujours un, il ne sert plus ensuite", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const a = await enrol(c)
    const b = await enrol(c, { label: 'Phone' })
    const other = await login(fx)
    assert.equal((await other.post('/api/passkeys/remove', { id: a.passkey.id })).json.error.code, 'passkey_required')
    assert.equal((await prove(other, b.auth)).status, 200)
    assert.equal((await other.post('/api/passkeys/remove', { id: 'inconnu' })).status, 404)
    assert.equal((await other.post('/api/passkeys/remove', { id: a.passkey.id })).status, 200)
    assert.equal((await other.post('/api/passkeys/remove', { id: b.passkey.id })).json.error.code, 'last_passkey')
    assert.deepEqual((await other.get('/api/passkeys')).json.passkeys.map((p) => p.label), ['Phone'])
    fx.advance(11 * 60)
    assert.equal((await other.post('/api/passkeys/remove', { id: b.passkey.id })).json.error.code, 'passkey_required', 'la preuve forte expire')
    assert.ok((await other.get('/api/audit')).json.entries.some((e) => e.action === 'passkey.removed'))
  } finally {
    await fx.close()
  }
})

/* ------------------------- autorisations remises au fournisseur ------------------------- */

const check = (c, chain, to, amount) => c.post('/api/transfers/check', { chain, to, amount })

test("signer sans passkey (compte pas encore équipé): le mot de passe récent suffit, jeton court au même sub que la connexion", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const login = await verifyJwt(fx, (await c.post('/api/local/login', {})).json.jwt)
    const r = await c.post('/api/authorize/begin', { action: 'sign' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.method, 'password')
    const a = await verifyJwt(fx, r.json.assertion)
    assert.ok(a.ok)
    assert.equal(a.claims.sub, login.claims.sub)
    assert.equal(a.claims.scope, 'wallet:sign')
    assert.equal(a.claims.email, undefined)
    assert.equal(a.claims.exp - a.claims.iat, 120)
    fx.advance(301)
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign' })).json.error.code, 'reauth_required')
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign', password: PASSWORD })).status, 200)
    assert.equal((await new Client(fx.api).post('/api/authorize/begin', { action: 'sign' })).status, 401)
    // Exporter la clé n'est jamais possible sans passkey.
    assert.equal((await c.post('/api/authorize/begin', { action: 'export', password: PASSWORD })).json.error.code, 'no_passkey')
  } finally {
    await fx.close()
  }
})

test("signer avec un passkey: défi lié à CE transfert, jeton wallet:sign, autorisation consommée (une décision de la banque ne sert qu'une fois)", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const { auth } = await enrol(c)
    const login = await verifyJwt(fx, (await c.post('/api/local/login', {})).json.jwt)
    const verdict = (await check(c, 'EVM', CLEAN.EVM, 0.1)).json
    assert.equal(verdict.allowed, true)

    const begin = await c.post('/api/authorize/begin', { action: 'sign', authorizationId: verdict.authorizationId })
    assert.equal(begin.status, 200, JSON.stringify(begin.json))
    assert.equal(begin.json.method, 'passkey')
    assert.equal(begin.json.publicKey.allowCredentials.length, 1)
    assert.equal(begin.json.publicKey.userVerification, 'required')
    // Aucun jeton tant que le passkey n'a pas répondu.
    assert.equal(begin.json.assertion, undefined)
    const fin = await c.post('/api/authorize/finish', { challengeId: begin.json.challengeId, credential: auth.get(begin.json.publicKey) })
    assert.equal(fin.status, 200, JSON.stringify(fin.json))
    const a = await verifyJwt(fx, fin.json.assertion)
    assert.ok(a.ok)
    assert.equal(a.claims.scope, 'wallet:sign')
    assert.equal(a.claims.sub, login.claims.sub)
    const entry = (await c.get('/api/audit')).json.entries.find((e) => e.action === 'signing.authorized')
    assert.equal(entry.detail.method, 'passkey')
    assert.equal(entry.detail.authorizationId, verdict.authorizationId)

    // La même décision ne sert pas deux fois, ni pour un second jeton.
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign', authorizationId: verdict.authorizationId })).json.error.code, 'authorization_used')
    assert.equal((await c.post('/api/transfers/report', { authorizationId: verdict.authorizationId, hash: '0x1' })).status, 200, 'le rapport de diffusion reste possible')
  } finally {
    await fx.close()
  }
})

test("signer: pas de jeton sans une vraie réponse du passkey, ni avec la réponse d'un autre défi, d'un autre compte ou d'une autre session", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const { auth } = await enrol(c)
    const begin = await c.post('/api/authorize/begin', { action: 'sign' })
    const wrongKey = softwareAuthenticator({ origin: ORIGIN })
    assert.equal((await c.post('/api/authorize/finish', { challengeId: begin.json.challengeId, credential: wrongKey.get(begin.json.publicKey) })).status, 401, 'un passkey inconnu')

    const b2 = await c.post('/api/authorize/begin', { action: 'sign' })
    assert.equal((await c.post('/api/authorize/finish', { challengeId: b2.json.challengeId, credential: auth.get(b2.json.publicKey, { uv: false }) })).status, 401, 'sans vérification de l\'utilisateur')

    // Un défi de session ne s'utilise pas depuis une autre session (même avec le bon passkey).
    const b3 = await c.post('/api/authorize/begin', { action: 'sign' })
    const other = await login(fx)
    assert.equal((await other.post('/api/authorize/finish', { challengeId: b3.json.challengeId, credential: auth.get(b3.json.publicKey) })).json.error.code, 'invalid_challenge')

    // Le passkey d'un autre compte ne vaut rien.
    const rival = await signedUp(fx, 'rival@example.ch')
    const rivalKey = (await enrol(rival)).auth
    const b4 = await c.post('/api/authorize/begin', { action: 'sign' })
    assert.equal((await c.post('/api/authorize/finish', { challengeId: b4.json.challengeId, credential: rivalKey.get(b4.json.publicKey) })).status, 401)

    // Un défi de connexion n'autorise pas une signature.
    const lo = await new Client(fx.api).post('/api/passkeys/auth/options', { purpose: 'login' })
    assert.equal((await c.post('/api/authorize/finish', { challengeId: lo.json.challengeId, credential: auth.get(lo.json.publicKey) })).json.error.code, 'invalid_challenge')
    // Ni l'inverse: un défi de signature ne connecte pas.
    const b5 = await c.post('/api/authorize/begin', { action: 'sign' })
    assert.equal((await new Client(fx.api).post('/api/passkeys/auth/verify', { challengeId: b5.json.challengeId, credential: auth.get(b5.json.publicKey) })).json.error.code, 'invalid_challenge')
  } finally {
    await fx.close()
  }
})

test("signer un transfert: autorisation inconnue, refusée par la banque, périmée, ou d'un autre compte: aucune demande", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await enrol(c)
    const begin = (id) => c.post('/api/authorize/begin', { action: 'sign', authorizationId: id })
    assert.equal((await begin('inconnue')).status, 404)
    const refused = (await check(c, 'BTC', CLEAN.BTC, 0.02)).json
    const cleared = (await check(c, 'EVM', CLEAN.EVM, 0.1)).json
    assert.equal(refused.allowed, false)
    const refusedId = fx.bank.db.prepare("SELECT id FROM authorizations WHERE status = 'refused'").get().id
    assert.equal((await begin(refusedId)).json.error.code, 'not_cleared', 'une décision de refus ne donne jamais de jeton')
    // Sans identifiant de transfert, c'est une preuve de propriété (un message): permise, et tracée comme telle.
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign' })).json.method, 'passkey')
    const rival = await signedUp(fx, 'rival@example.ch')
    await enrol(rival)
    assert.equal((await rival.post('/api/authorize/begin', { action: 'sign', authorizationId: cleared.authorizationId })).status, 404, "l'autorisation d'un autre compte")
    fx.advance(11 * 60)
    assert.equal((await begin(cleared.authorizationId)).json.error.code, 'expired')
  } finally {
    await fx.close()
  }
})

test("exporter la clé: toujours un passkey, jeton wallet:export distinct, trace dans l'audit", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    assert.equal((await c.post('/api/authorize/begin', { action: 'export' })).json.error.code, 'no_passkey')
    const { auth } = await enrol(c)
    const begin = await c.post('/api/authorize/begin', { action: 'export' })
    assert.equal(begin.json.method, 'passkey')
    const fin = await c.post('/api/authorize/finish', { challengeId: begin.json.challengeId, credential: auth.get(begin.json.publicKey) })
    assert.equal((await verifyJwt(fx, fin.json.assertion)).claims.scope, 'wallet:export')
    assert.ok((await c.get('/api/audit')).json.entries.some((e) => e.action === 'export.authorized'))
    assert.equal((await c.post('/api/authorize/begin', { action: 'delete-everything' })).json.error.code, 'invalid_action')
  } finally {
    await fx.close()
  }
})

test("l'ancienne autorisation « lier un passkey chez le fournisseur » n'existe plus: aucun passkey ne peut être ajouté chez le fournisseur", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    assert.equal((await c.post('/api/dynamic/assertion', { scope: 'credential:link' })).status, 404)
    assert.equal((await c.post('/api/authorize/begin', { action: 'credential:link' })).json.error.code, 'invalid_action')
  } finally {
    await fx.close()
  }
})

test("un passkey enregistré pour une adresse ne sert pas pour une autre (identifiant de partie de confiance)", async () => {
  const fx = await startFixture({ overrides: { allowedOrigins: ['http://localhost:5173', 'https://equinox.example'] } })
  try {
    const c = await signedUp(fx)
    await enrol(c) // enregistré pour « localhost »
    const elsewhere = new Client(fx.api)
    assert.equal((await elsewhere.post('/api/login', { email: EMAIL, password: PASSWORD }, { origin: 'https://equinox.example' })).status, 200)
    const post = (path, body) => elsewhere.post(path, body, { origin: 'https://equinox.example' })
    assert.equal((await post('/api/authorize/begin', { action: 'sign' })).json.error.code, 'no_passkey_here')
    assert.equal((await post('/api/passkeys/auth/options', { purpose: 'manage' })).json.error.code, 'no_passkey_here')
    // Là-bas, l'inscription repart de zéro côté exclusion, et passe par la récupération (aucune preuve possible).
    const reg = await post('/api/passkeys/register/options', {})
    assert.equal(reg.status, 202)
  } finally {
    await fx.close()
  }
})

test("autorisations: demandes bornées par session", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    let last
    for (let i = 0; i < 31; i++) last = await c.post('/api/authorize/begin', { action: 'sign' })
    assert.equal(last.status, 429)
  } finally {
    await fx.close()
  }
})

test("défense en profondeur: un passkey inscrit pour une adresse ne connecte pas sur une autre, même si l'authentificateur mentait sur sa partie de confiance", async () => {
  const fx = await startFixture({ overrides: { allowedOrigins: ['http://localhost:5173', 'https://equinox.example'] } })
  try {
    const c = await signedUp(fx)
    const { auth } = await enrol(c) // inscrit pour « localhost »
    const elsewhere = new Client(fx.api)
    const o = await elsewhere.post('/api/passkeys/auth/options', { purpose: 'login' }, { origin: 'https://equinox.example' })
    assert.equal(o.status, 200)
    const lying = auth.get(o.json.publicKey, { origin: 'https://equinox.example', rpId: 'equinox.example' })
    const res = await elsewhere.post('/api/passkeys/auth/verify', { challengeId: o.json.challengeId, credential: lying }, { origin: 'https://equinox.example' })
    assert.equal(res.status, 401)
  } finally {
    await fx.close()
  }
})

test("une même décision de la banque ne donne qu'un jeton, même si deux demandes ont été ouvertes avant la première réponse", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const { auth } = await enrol(c)
    const verdict = (await check(c, 'EVM', CLEAN.EVM, 0.1)).json
    const one = await c.post('/api/authorize/begin', { action: 'sign', authorizationId: verdict.authorizationId })
    const two = await c.post('/api/authorize/begin', { action: 'sign', authorizationId: verdict.authorizationId })
    assert.equal(one.status, 200)
    assert.equal(two.status, 200, 'les deux demandes passent: aucune réponse n\'a encore été donnée')
    const first = await c.post('/api/authorize/finish', { challengeId: one.json.challengeId, credential: auth.get(one.json.publicKey) })
    assert.equal(first.status, 200)
    const second = await c.post('/api/authorize/finish', { challengeId: two.json.challengeId, credential: auth.get(two.json.publicKey) })
    assert.equal(second.status, 409)
    assert.equal(second.json.error.code, 'authorization_used')
  } finally {
    await fx.close()
  }
})
