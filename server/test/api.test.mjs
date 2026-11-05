import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { CLEAN, Client, ORIGIN, signedUp, startFixture, verifyJwt } from './helpers.mjs'

const EMAIL = 'client@example.ch'
const PASSWORD = 'a long enough password'
const check = (c, chain, to, amount) => c.post('/api/transfers/check', { chain, to, amount })

/* ------------------------------ comptes ------------------------------ */

test('inscription: cookie HttpOnly SameSite, session valide, doublon et mot de passe faible refusés', async () => {
  const fx = await startFixture()
  try {
    const c = new Client(fx.api)
    const r = await c.post('/api/register', { email: EMAIL, password: PASSWORD })
    assert.equal(r.status, 200)
    assert.match(r.setCookie, /HttpOnly/)
    assert.match(r.setCookie, /SameSite=Lax/)
    assert.equal((await c.get('/api/me')).json.account.email, EMAIL)
    assert.equal((await new Client(fx.api).post('/api/register', { email: EMAIL, password: PASSWORD })).status, 409)
    assert.equal((await new Client(fx.api).post('/api/register', { email: 'x@example.ch', password: 'short' })).json.error.code, 'weak_password')
    assert.equal((await new Client(fx.api).post('/api/register', { email: 'not-an-email', password: PASSWORD })).json.error.code, 'invalid_email')
  } finally {
    await fx.close()
  }
})

test('inscription réservée aux adresses invitées', async () => {
  const fx = await startFixture({ overrides: { allowedEmails: ['*@example.ch'] } })
  try {
    assert.equal((await new Client(fx.api).post('/api/register', { email: 'a@evil.test', password: PASSWORD })).json.error.code, 'not_invited')
    assert.equal((await new Client(fx.api).post('/api/register', { email: 'a@example.ch', password: PASSWORD })).status, 200)
  } finally {
    await fx.close()
  }
})

test("connexion: mêmes messages pour un compte inconnu et un mauvais mot de passe, blocage après 5 échecs", async () => {
  const fx = await startFixture()
  try {
    await signedUp(fx)
    const c = new Client(fx.api)
    const wrong = await c.post('/api/login', { email: EMAIL, password: 'nope nope nope' })
    const unknown = await c.post('/api/login', { email: 'ghost@example.ch', password: 'nope nope nope' })
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong.json, unknown.json) // aucune fuite sur l'existence du compte
    for (let i = 0; i < 4; i++) await c.post('/api/login', { email: EMAIL, password: 'bad bad bad bad' })
    assert.equal((await c.post('/api/login', { email: EMAIL, password: PASSWORD })).status, 429) // même le bon mot de passe est refusé
    fx.advance(61)
    assert.equal((await c.post('/api/login', { email: EMAIL, password: PASSWORD })).status, 200)
  } finally {
    await fx.close()
  }
})

test('déconnexion: le cookie ne marche plus', async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const old = c.cookie
    await c.post('/api/logout', {})
    const replay = new Client(fx.api)
    replay.cookie = old
    assert.equal((await replay.get('/api/me')).status, 401)
  } finally {
    await fx.close()
  }
})

test('une session expire', async () => {
  const fx = await startFixture({ overrides: { sessionTtlSeconds: 100 } })
  try {
    const c = await signedUp(fx)
    fx.advance(101)
    assert.equal((await c.get('/api/me')).status, 401)
  } finally {
    await fx.close()
  }
})

test("anti-CSRF: origine absente ou étrangère refusée, JSON obligatoire, rien sans session", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    assert.equal((await c.post('/api/logout', {}, { origin: null })).status, 403)
    assert.equal((await c.post('/api/logout', {}, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await c.post('/api/logout', {}, { contentType: 'text/plain' })).status, 415)
    assert.equal((await new Client(fx.api).get('/api/audit')).status, 401)
    assert.equal((await new Client(fx.api).get('/api/policy')).status, 401)
  } finally {
    await fx.close()
  }
})

/* --------------------------- jetons du wallet --------------------------- */

test('jeton de connexion: signé par la banque, vérifiable avec la clé publique, claims attendus', async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const me = (await c.get('/api/me')).json.account
    const { jwt } = (await c.post('/api/local/login', {})).json
    const { ok, header, claims } = await verifyJwt(fx, jwt)
    assert.ok(ok, 'la signature doit être valide avec la clé publiée')
    assert.equal(header.alg, 'RS256')
    assert.equal(header.kid, fx.config.kid)
    assert.equal(claims.iss, fx.config.issuer)
    assert.equal(claims.aud, fx.config.audience)
    assert.equal(claims.sub, `sq-${me.id}`)
    assert.equal(claims.email, EMAIL)
    assert.equal(claims.emailVerified, true)
    assert.equal(claims.exp - claims.iat, 300)
  } finally {
    await fx.close()
  }
})

test('jeton de connexion: refusé sans session', async () => {
  const fx = await startFixture()
  try {
    assert.equal((await new Client(fx.api).post('/api/local/login', {})).status, 401)
  } finally {
    await fx.close()
  }
})

test("le serveur public n'expose que la clé PUBLIQUE", async () => {
  const fx = await startFixture()
  try {
    const { keys } = await (await fetch(`${fx.jwks}/.well-known/jwks.json`)).json()
    assert.equal(keys.length, 1)
    assert.equal(keys[0].d, undefined)
    assert.equal(keys[0].p, undefined)
    assert.equal((await fetch(`${fx.jwks}/api/health`)).status, 404)
    assert.equal((await fetch(`${fx.jwks}/api/audit`)).status, 404)
  } finally {
    await fx.close()
  }
})

/* ---------------------- autorisation d'un passkey ---------------------- */

test("base existante: les colonnes ajoutées après coup sont migrées sans perdre les données", async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { openDb } = await import('../src/db.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'equinox-migrate-'))
  try {
    const old = new DatabaseSync(join(dir, 'old.sqlite'))
    old.exec('CREATE TABLE passkey_grants (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope TEXT NOT NULL, requested_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, issued_at INTEGER, cancelled_at INTEGER)')
    old.prepare('INSERT INTO passkey_grants (id, account_id, scope, requested_at, ready_at) VALUES (?, ?, ?, ?, ?)').run('g1', 'a1', 'credential:link', 1, 1)
    old.close()
    const db = openDb(join(dir, 'old.sqlite'))
    const cols = db.prepare('PRAGMA table_info(passkey_grants)').all().map((c) => c.name)
    assert.ok(cols.includes('confirmed_at') && cols.includes('attempts'))
    assert.ok(db.prepare('PRAGMA table_info(webauthn_credentials)').all().length > 0, 'les tables de passkeys sont créées')
    assert.equal(db.prepare('SELECT attempts FROM passkey_grants WHERE id = ?').get('g1').attempts, 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transfert: dans les limites accepté, au-dessus de la limite refusé avec le motif', async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const ok = await check(c, 'BTC', CLEAN.BTC, 0.005)
    assert.equal(ok.json.allowed, true)
    assert.ok(ok.json.authorizationId)
    const big = await check(c, 'BTC', CLEAN.BTC, 0.5)
    assert.equal(big.json.allowed, false)
    assert.match(big.json.reasons.join(' '), /Limit per transfer exceeded/)
    assert.equal(big.json.authorizationId, undefined, 'un transfert refusé ne reçoit aucune autorisation')
  } finally {
    await fx.close()
  }
})

test("transfert: une adresse valide passe quand les règles configurées l'autorisent", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    const r = await check(c, 'EVM', '0x1111111111111111111111111111111111111111', 0.1)
    assert.equal(r.json.allowed, true)
    assert.ok(r.json.authorizationId)
  } finally {
    await fx.close()
  }
})

test('limite journalière: appliquée côté banque sur 24 h glissantes', async () => {
  const fx = await startFixture({ overrides: { sessionTtlSeconds: 3 * 24 * 3600 } })
  try {
    const c = await signedUp(fx)
    const r = await c.put('/api/policy', { policy: { maxPerTx: { BTC: 1, EVM: 1, SOL: 1 }, maxPerDay: { BTC: 0.03, EVM: 1, SOL: 1 }, allowlist: { BTC: [], EVM: [], SOL: [] }, blockUnknownDestinations: false } })
    assert.equal(r.status, 200)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, true)
    const second = await check(c, 'BTC', CLEAN.BTC, 0.02)
    assert.equal(second.json.allowed, false)
    assert.match(second.json.reasons.join(' '), /Daily limit exceeded/)
    fx.advance(25 * 3600)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, true)
  } finally {
    await fx.close()
  }
})

const LIMIT_03 = { policy: { maxPerTx: { BTC: 1, EVM: 1, SOL: 1 }, maxPerDay: { BTC: 0.03, EVM: 1, SOL: 1 }, allowlist: { BTC: [], EVM: [], SOL: [] }, blockUnknownDestinations: false } }

test("limite journalière: un contrôle jamais suivi d'un envoi est libéré quand la décision expire", async () => {
  const fx = await startFixture({ overrides: { sessionTtlSeconds: 3 * 24 * 3600 } })
  try {
    const c = await signedUp(fx)
    assert.equal((await c.put('/api/policy', LIMIT_03)).status, 200)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, true)
    const reserved = await check(c, 'BTC', CLEAN.BTC, 0.02)
    assert.equal(reserved.json.allowed, false, 'réservé tant que la décision est valable')
    assert.match(reserved.json.reasons.join(' '), /Daily limit exceeded/)
    fx.advance(11 * 60)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, true, 'décision expirée et jamais utilisée: elle ne compte plus')
  } finally {
    await fx.close()
  }
})

test("limite journalière: une décision utilisée pour signer compte pendant 24 h, qu'elle soit rapportée, oubliée ou annoncée en échec", async () => {
  const fx = await startFixture({ overrides: { sessionTtlSeconds: 3 * 24 * 3600 } })
  try {
    const c = await signedUp(fx)
    assert.equal((await c.put('/api/policy', LIMIT_03)).status, 200)
    // Autorisée pour signer (mot de passe: compte sans passkey), puis jamais rapportée.
    const forgotten = await check(c, 'BTC', CLEAN.BTC, 0.02)
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign', authorizationId: forgotten.json.authorizationId, password: PASSWORD })).status, 200)
    fx.advance(11 * 60)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, false, 'une signature autorisée compte même sans rapport')
    fx.advance(25 * 3600)
    // Autorisée pour signer, puis le client annonce un échec: il ne peut pas se libérer en le disant.
    const failed = await check(c, 'BTC', CLEAN.BTC, 0.02)
    assert.equal(failed.json.allowed, true)
    assert.equal((await c.post('/api/authorize/begin', { action: 'sign', authorizationId: failed.json.authorizationId, password: PASSWORD })).status, 200)
    assert.equal((await c.post('/api/transfers/report', { authorizationId: failed.json.authorizationId, error: 'network error' })).status, 200)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, false, 'un « échec » annoncé après la signature compte aussi')
    // Un échec annoncé SANS avoir signé libère la décision: rien n'est parti.
    fx.advance(25 * 3600)
    const unsigned = await check(c, 'BTC', CLEAN.BTC, 0.02)
    assert.equal(unsigned.json.allowed, true)
    assert.equal((await c.post('/api/transfers/report', { authorizationId: unsigned.json.authorizationId, error: 'user cancelled' })).status, 200)
    assert.equal((await check(c, 'BTC', CLEAN.BTC, 0.02)).json.allowed, true, 'jamais signée: libérée')
  } finally {
    await fx.close()
  }
})

test('liste approuvée: refuse l\'inconnu, accepte l\'approuvé (EVM insensible à la casse)', async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await c.put('/api/policy', {
      policy: { maxPerTx: { BTC: 1, EVM: 1, SOL: 1 }, maxPerDay: { BTC: 9, EVM: 9, SOL: 9 }, allowlist: { BTC: [], EVM: [CLEAN.EVM], SOL: [] }, blockUnknownDestinations: true },
    })
    assert.equal((await check(c, 'EVM', CLEAN.EVM.toLowerCase(), 0.1)).json.allowed, true)
    const unknown = await check(c, 'EVM', '0x0000000000000000000000000000000000000001', 0.1)
    assert.equal(unknown.json.allowed, false)
    assert.match(unknown.json.reasons[0], /approved list/)
  } finally {
    await fx.close()
  }
})

test("politique: valeurs invalides et adresses mal formées refusées; chaque compte a la sienne", async () => {
  const fx = await startFixture()
  try {
    const a = await signedUp(fx, 'a@example.ch')
    const b = await signedUp(fx, 'b@example.ch')
    const good = { maxPerTx: { BTC: 1, EVM: 1, SOL: 1 }, maxPerDay: { BTC: 1, EVM: 1, SOL: 1 }, allowlist: { BTC: [], EVM: [], SOL: [] }, blockUnknownDestinations: false }
    assert.equal((await a.put('/api/policy', { policy: { ...good, maxPerTx: { BTC: -1, EVM: 1, SOL: 1 } } })).json.error.code, 'invalid_policy')
    assert.equal((await a.put('/api/policy', { policy: { ...good, maxPerTx: { BTC: 'a lot', EVM: 1, SOL: 1 } } })).status, 400)
    assert.equal((await a.put('/api/policy', { policy: { ...good, allowlist: { BTC: ['bc1-mainnet-not-allowed'], EVM: [], SOL: [] } } })).status, 400)
    assert.equal((await a.put('/api/policy', { policy: { ...good, maxPerTx: { BTC: 0.123, EVM: 1, SOL: 1 } } })).status, 200)
    assert.equal((await a.get('/api/policy')).json.policy.maxPerTx.BTC, 0.123)
    assert.equal((await b.get('/api/policy')).json.policy.maxPerTx.BTC, 0.01, 'le compte B garde la valeur par défaut')
  } finally {
    await fx.close()
  }
})

test("entrées invalides: réseau, adresse, montant", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    assert.equal((await check(c, 'DOGE', CLEAN.BTC, 1)).json.error.code, 'invalid_chain')
    assert.equal((await check(c, 'BTC', 'bc1qmainnetaddressthatshouldnotbeaccepted000000', 1)).json.error.code, 'invalid_address')
    assert.equal((await check(c, 'EVM', '0x123', 1)).json.error.code, 'invalid_address')
    for (const amount of [0, -1, '1', null, Infinity]) assert.equal((await check(c, 'EVM', CLEAN.EVM, amount)).status, 400, `montant ${amount}`)
  } finally {
    await fx.close()
  }
})

test("rapport de diffusion: seulement pour un transfert autorisé, une fois, avant expiration, par son propriétaire", async () => {
  const fx = await startFixture()
  try {
    const a = await signedUp(fx, 'a@example.ch')
    const b = await signedUp(fx, 'b@example.ch')
    const ok = (await check(a, 'EVM', CLEAN.EVM, 0.1)).json
    assert.equal((await b.post('/api/transfers/report', { authorizationId: ok.authorizationId, hash: '0xabc' })).status, 404, "pas celui d'un autre compte")
    assert.equal((await a.post('/api/transfers/report', { authorizationId: ok.authorizationId, hash: '0xabc' })).status, 200)
    assert.equal((await a.post('/api/transfers/report', { authorizationId: ok.authorizationId, hash: '0xdef' })).status, 409, 'une seule fois')

    const late = (await check(a, 'EVM', CLEAN.EVM, 0.1)).json
    fx.advance(11 * 60)
    assert.equal((await a.post('/api/transfers/report', { authorizationId: late.authorizationId, hash: '0x1' })).status, 410, 'expirée')

    const refused = (await check(a, 'EVM', CLEAN.EVM, 2)).json
    assert.equal(refused.authorizationId, undefined)
    assert.equal((await a.post('/api/transfers/report', { authorizationId: 'whatever', hash: '0x1' })).status, 404)
  } finally {
    await fx.close()
  }
})

/* ---------------------------------- audit ---------------------------------- */

test("audit: chaque événement de sécurité est journalisé, la chaîne est intègre, et une falsification est détectée", async () => {
  const fx = await startFixture()
  try {
    const c = await signedUp(fx)
    await c.post('/api/local/login', {})
    await check(c, 'EVM', CLEAN.EVM, 0.1)
    await check(c, 'EVM', CLEAN.EVM, 2)
    const audit = (await c.get('/api/audit')).json
    const actions = audit.entries.map((e) => e.action)
    for (const expected of ['account.created', 'wallet.login_token', 'transfer.cleared', 'transfer.refused']) {
      assert.ok(actions.includes(expected), `manque ${expected}`)
    }
    assert.equal(audit.integrity.ok, true)
    assert.ok(audit.integrity.count >= 4)

    // Un employé malveillant modifie une ligne directement dans la base.
    fx.bank.db.prepare("UPDATE audit SET action = 'nothing.to.see' WHERE action = 'transfer.refused'").run()
    const tampered = (await c.get('/api/audit')).json
    assert.equal(tampered.integrity.ok, false)
    assert.ok(tampered.integrity.brokenAtSeq > 0)
  } finally {
    await fx.close()
  }
})

test("audit: un compte ne voit jamais celui d'un autre", async () => {
  const fx = await startFixture()
  try {
    const a = await signedUp(fx, 'a@example.ch')
    const b = await signedUp(fx, 'b@example.ch')
    await check(a, 'EVM', CLEAN.EVM, 0.1)
    const seenByB = (await b.get('/api/audit')).json.entries
    assert.ok(seenByB.every((e) => e.action === 'account.created'))
    assert.equal(seenByB.length, 1)
  } finally {
    await fx.close()
  }
})

test('mots de passe: jamais stockés en clair', async () => {
  const fx = await startFixture()
  try {
    await signedUp(fx)
    const row = fx.bank.db.prepare('SELECT pw_salt, pw_hash FROM accounts').get()
    assert.ok(!JSON.stringify(row).includes(PASSWORD))
    assert.equal(row.pw_hash.length, 128)
  } finally {
    await fx.close()
  }
})

test('origine: la valeur par défaut est celle de l\'application', () => {
  assert.equal(ORIGIN, 'http://localhost:5173')
})

/* --------------------------- écoute (déploiement) --------------------------- */

test("l'API peut écouter sur un socket Unix privé (0600), sans aucun port TCP", async () => {
  const { mkdtempSync, rmSync, statSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { request } = await import('node:http')
  const dir = mkdtempSync(join(tmpdir(), 'equinox-sock-'))
  const apiSocket = join(dir, 'api.sock')
  writeFileSync(apiSocket, 'reste d un arrêt brutal') // un vieux fichier ne doit pas empêcher le démarrage
  const fx = await startFixture({ overrides: { apiSocket, apiPort: undefined } })
  try {
    assert.equal(fx.bank.apiPort, undefined)
    assert.equal(fx.bank.apiSocket, apiSocket)
    assert.equal(statSync(apiSocket).mode & 0o777, 0o600)
    const res = await new Promise((resolve, reject) => {
      request({ socketPath: apiSocket, path: '/api/health', method: 'GET' }, (r) => {
        let body = ''
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode, body }))
      })
        .on('error', reject)
        .end()
    })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
    // Le JWKS reste public et séparé.
    assert.equal((await fetch(`${fx.jwks}/.well-known/jwks.json`)).status, 200)
  } finally {
    await fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("l'API peut écouter sur un port TCP ET sur un socket Unix en même temps (proxy HTTPS + administration)", async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { request } = await import('node:http')
  const dir = mkdtempSync(join(tmpdir(), 'equinox-both-'))
  const apiSocket = join(dir, 'api.sock')
  const fx = await startFixture({ overrides: { apiSocket } }) // apiPort: 0 vient de la fixture
  try {
    assert.equal(typeof fx.bank.apiPort, 'number')
    assert.equal(fx.bank.apiSocket, apiSocket)
    assert.equal((await fetch(`${fx.api}/api/health`)).status, 200)
    const viaSocket = await new Promise((resolve, reject) => {
      request({ socketPath: apiSocket, path: '/api/health', method: 'GET' }, (r) => resolve(r.statusCode)).on('error', reject).end()
    })
    assert.equal(viaSocket, 200)
  } finally {
    await fx.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("démarrage refusé si l'API n'a aucune adresse d'écoute", async () => {
  await assert.rejects(startFixture({ overrides: { apiPort: undefined, apiSocket: undefined } }), /Aucune adresse d'écoute/)
})

test('configuration: origines en liste, écoute par défaut, socket seul, socket et port', async () => {
  const { loadConfig } = await import('../src/config.mjs')
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('BANK_')))
  const clear = () => Object.keys(process.env).filter((k) => k.startsWith('BANK_')).forEach((k) => delete process.env[k])
  try {
    clear()
    assert.deepEqual(loadConfig().allowedOrigins, ['http://localhost:5173'])
    assert.equal(loadConfig().apiPort, 8787)
    assert.equal(loadConfig().apiHost, '127.0.0.1')
    assert.equal(loadConfig().trustProxy, false)
    assert.equal(loadConfig().dataDir, fileURLToPath(new URL('../data', import.meta.url)))
    process.env.BANK_ALLOWED_ORIGINS = 'https://equinox.example, http://localhost:5173 ,'
    assert.deepEqual(loadConfig().allowedOrigins, ['https://equinox.example', 'http://localhost:5173'])
    process.env.BANK_API_SOCKET = '/run/bank/api.sock'
    assert.equal(loadConfig().apiPort, undefined) // socket seul
    process.env.BANK_API_PORT = '8787'
    process.env.BANK_API_HOST = '0.0.0.0'
    assert.equal(loadConfig().apiPort, 8787) // socket et port
    assert.equal(loadConfig().apiHost, '0.0.0.0')
    process.env.BANK_TRUST_PROXY = '1'
    assert.equal(loadConfig().trustProxy, true)
  } finally {
    clear()
    Object.assign(process.env, saved)
  }
})

test('origines: plusieurs origines autorisées (application publique et développement), toute autre refusée', async () => {
  const fx = await startFixture({ overrides: { allowedOrigins: ['https://equinox.example', 'http://localhost:5173'] } })
  try {
    const c = new Client(fx.api)
    // 401 = l'origine est acceptée (le mot de passe est faux), 403 = refusée avant tout traitement.
    const status = (origin) => c.post('/api/login', { email: EMAIL, password: 'wrong password!' }, { origin }).then((r) => r.status)
    assert.equal(await status('https://equinox.example'), 401)
    assert.equal(await status('http://localhost:5173'), 401)
    assert.equal(await status('http://equinox.example'), 403) // même hôte, autre schéma
    assert.equal(await status('https://equinox.example.evil.com'), 403)
    assert.equal(await status('null'), 403)
    assert.equal(await status(null), 403)
  } finally {
    await fx.close()
  }
})

test("blocage par compte et par adresse: l'adresse du client (pas celle du proxy) entre dans la clé", async () => {
  const fx = await startFixture({ overrides: { trustProxy: true } })
  try {
    const c = await signedUp(fx)
    const bad = (ip) => c.post('/api/login', { email: EMAIL, password: 'not the password' }, { headers: { 'x-forwarded-for': ip } })
    for (let i = 0; i < 5; i++) assert.equal((await bad('3.3.3.3')).status, 401)
    assert.equal((await bad('3.3.3.3')).json.error.code, 'too_many_attempts') // cette adresse est bloquée sur ce compte
    // Le propriétaire, depuis une autre adresse, n'est pas bloqué par quelqu'un d'autre.
    const ok = await new Client(fx.api).post('/api/login', { email: EMAIL, password: PASSWORD }, { headers: { 'x-forwarded-for': '4.4.4.4' } })
    assert.equal(ok.status, 200)
  } finally {
    await fx.close()
  }
})
