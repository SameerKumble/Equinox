import { randomBytes } from 'node:crypto'
import { appendAudit, listAudit, verifyAudit } from './audit.mjs'
import { ChainError } from './chain.mjs'
import { hashPassword, newId, newToken, sha256hex, verifyPassword } from './crypto.mjs'
import { CHAINS, defaultPolicy, evaluate, isValidAddress, normalizeAddress, PolicyError, validatePolicy } from './policy.mjs'
import { b64u, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.mjs'

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
const COOKIE = 'equinox_session'
const MAX_BODY = 64 * 1024
const MAX_FAILURES = 5
const LOCK_MS = 60_000
const TRANSFER_TTL_MS = 10 * 60_000
// Une demande d'ajout de passkey (récupération) dont l'enregistrement n'a pas abouti peut être redemandée dans cette fenêtre,
// au plus MAX_ATTEMPTS fois, sans relancer tout le délai de sécurité.
const REISSUE_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
// Portée des demandes d'ajout de passkey par récupération (délai de sécurité).
const ENROLL_SCOPE = 'passkey:enroll'
// Une vérification de passkey vaut preuve forte (sans redemander le mot de passe) pendant cette durée.
const STRONG_MS = 10 * 60_000
const CHALLENGE_TTL_MS = 5 * 60_000
const CEREMONY_TIMEOUT_MS = 120_000
const MAX_LABEL = 60
// Ce que la banque autorise auprès du fournisseur de wallet: signer ou exporter la clé. Aucune autre action, aucun passkey du fournisseur.
const ASSERTION_SCOPE = { sign: 'wallet:sign', export: 'wallet:export' }
const CHAIN_PATH = /^\/api\/chain\/(BTC|EVM|SOL)\/([A-Za-z0-9]{20,100})$/
// Au-delà, les tables de suivi (adresses, comptes) purgent leurs entrées expirées: elles ne grossissent pas sans fin.
const MAX_TRACKED = 10_000
const DUMMY = hashPassword('not a real password') // compare toujours un hachage, même si le compte n'existe pas

const wildcard = (pattern) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is too large')
    chunks.push(c)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be valid JSON')
  }
}

export function createApi({ config, db, signer, chain, now = Date.now }) {
  const failures = new Map() // email|ip -> { count, lockedUntil, last }
  const allowed = config.allowedEmails.map(wildcard)
  const reauthMs = config.reauthWindowSeconds * 1000
  const delayMs = config.recoveryDelaySeconds * 1000

  /* ------------------------------ sessions ------------------------------ */

  function cookieHeader(token, maxAgeSeconds) {
    const base = `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
    return config.secureCookies ? `${base}; Secure` : base
  }

  function startSession(accountId, { strong = false } = {}) {
    const token = newToken()
    const t = now()
    db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, reauth_at, strong_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      sha256hex(token),
      accountId,
      t,
      t + config.sessionTtlSeconds * 1000,
      t,
      strong ? t : null,
    )
    return token
  }

  function sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (!token) return null
    const row = db
      .prepare(
        'SELECT s.token_hash, s.account_id, s.expires_at, s.reauth_at, s.strong_at, a.email, a.pw_salt, a.pw_hash FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?',
      )
      .get(sha256hex(token))
    return row && row.expires_at > now() ? row : null
  }

  function requireSession(req) {
    const s = sessionFrom(req)
    if (!s) throw new HttpError(401, 'unauthenticated', 'Sign in to your bank account first')
    return s
  }

  /* --------------------------- mots de passe --------------------------- */

  function throttle(key) {
    const f = failures.get(key)
    if (f && f.lockedUntil > now()) {
      throw new HttpError(429, 'too_many_attempts', `Too many attempts. Wait ${Math.ceil((f.lockedUntil - now()) / 1000)} seconds.`)
    }
  }
  function recordFailure(key) {
    const t = now()
    if (failures.size > MAX_TRACKED) for (const [k, v] of failures) if (v.lockedUntil <= t && t - v.last > LOCK_MS) failures.delete(k)
    const f = failures.get(key) ?? { count: 0, lockedUntil: 0, last: t }
    f.count += 1
    f.last = t
    if (f.count >= MAX_FAILURES) {
      f.lockedUntil = t + LOCK_MS
      f.count = 0
    }
    failures.set(key, f)
  }

  /**
   * Adresse du client. Derrière le proxy HTTPS (BANK_TRUST_PROXY=1) c'est la dernière valeur de X-Forwarded-For, celle que le
   * proxy ajoute lui-même: les valeurs envoyées par le client viennent avant et sont ignorées.
   */
  function clientIp(req) {
    if (config.trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (hops.length) return hops[hops.length - 1]
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** Vérifie un mot de passe contre un compte (ou un faux compte) sans révéler lequel des deux a échoué. */
  function passwordMatches(account, password) {
    const ref = account ?? { pw_salt: DUMMY.salt, pw_hash: DUMMY.hash }
    return verifyPassword(String(password ?? ''), ref.pw_salt, ref.pw_hash) && !!account
  }

  /* ------------------------------- passkeys ------------------------------- */

  const strongFresh = (s) => Boolean(s.strong_at) && now() - s.strong_at <= STRONG_MS
  const markStrong = (s) => db.prepare('UPDATE sessions SET strong_at = ?, reauth_at = ? WHERE token_hash = ?').run(now(), now(), s.token_hash)
  const activeCredentials = (accountId) => db.prepare('SELECT * FROM webauthn_credentials WHERE account_id = ? AND removed_at IS NULL ORDER BY created_at').all(accountId)
  const describeCredential = (c) => ({ id: c.id, label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at, synced: Boolean(c.backed_up) })
  const cleanLabel = (v) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_LABEL) || 'Passkey'
  const rpIdOf = (origin) => new URL(origin).hostname

  /** Origine de la requête, déjà contrôlée par la protection anti-CSRF: c'est elle qui fixe l'identifiant de partie de confiance. */
  const originOf = (req) => {
    const origin = req.headers.origin
    if (!config.allowedOrigins.includes(origin)) throw new HttpError(403, 'bad_origin', 'Request origin is not allowed')
    return origin
  }

  /** Preuve récente de présence: un passkey vérifié, ou le mot de passe saisi il y a peu (sinon on le redemande). */
  function ensureFresh(s, body, scope) {
    if (strongFresh(s) || now() - s.reauth_at <= reauthMs) return
    const key = `reauth|${s.account_id}`
    throttle(key)
    if (typeof body.password !== 'string') throw new HttpError(401, 'reauth_required', 'Enter your password again to continue')
    if (!verifyPassword(body.password, s.pw_salt, s.pw_hash)) {
      recordFailure(key)
      appendAudit(db, s.account_id, 'reauth.failed', { scope }, now())
      throw new HttpError(401, 'reauth_required', 'Password is incorrect')
    }
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?').run(now(), s.token_hash)
  }

  function issueChallenge({ purpose, accountId = null, sessionHash = null, binding = null, origin }) {
    const t = now()
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(t - 3_600_000)
    const id = newId()
    const challenge = randomBytes(32)
    const rpId = rpIdOf(origin)
    db.prepare(
      'INSERT INTO webauthn_challenges (id, purpose, challenge, account_id, session_hash, binding, rp_id, origin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, purpose, b64u.encode(challenge), accountId, sessionHash, binding, rpId, origin, t, t + CHALLENGE_TTL_MS)
    return { id, challenge: b64u.encode(challenge), rpId }
  }

  /** Un défi ne sert qu'une fois, réussi ou non, pour la session et l'action qui l'ont demandé. */
  function takeChallenge(req, id, purposes) {
    const row = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(String(id ?? ''))
    if (!row || row.used_at || row.expires_at <= now() || !purposes.includes(row.purpose)) throw new HttpError(400, 'invalid_challenge', 'This request has expired. Start again.')
    const s = row.session_hash ? requireSession(req) : null
    if (s && s.token_hash !== row.session_hash) throw new HttpError(400, 'invalid_challenge', 'This request has expired. Start again.')
    db.prepare('UPDATE webauthn_challenges SET used_at = ? WHERE id = ?').run(now(), row.id)
    return { row, s }
  }

  function passkeyError(e, accountId) {
    if (!(e instanceof WebAuthnError)) throw e
    if (e.code === 'counter' && accountId) appendAudit(db, accountId, 'passkey.clone_suspected', {}, now())
    throw new HttpError(401, 'invalid_passkey', 'This passkey could not be verified')
  }

  /** Vérifie la réponse d'un passkey pour un défi. Rend le passkey utilisé (compteur et date mis à jour). */
  function checkAssertion(row, credential) {
    const stored = db.prepare('SELECT * FROM webauthn_credentials WHERE id = ? AND removed_at IS NULL').get(String(credential?.id ?? ''))
    if (!stored || stored.rp_id !== row.rp_id || (row.account_id && stored.account_id !== row.account_id)) throw new HttpError(401, 'invalid_passkey', 'This passkey could not be verified')
    let result
    try {
      result = verifyAssertion({
        credential,
        expectedChallenge: b64u.decode(row.challenge),
        allowedOrigins: [row.origin],
        rpId: row.rp_id,
        stored: { jwk: JSON.parse(stored.public_key), alg: stored.alg, signCount: stored.sign_count },
      })
    } catch (e) {
      passkeyError(e, stored.account_id)
    }
    // Connexion sans identifiant: le passkey doit désigner son compte (identifiant d'utilisateur), la clé seule ne suffit pas.
    if (row.purpose === 'login' && (!result.userHandle || result.userHandle.toString() !== stored.account_id)) throw new HttpError(401, 'invalid_passkey', 'This passkey could not be verified')
    db.prepare('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ?, backed_up = ? WHERE id = ?').run(result.signCount, now(), result.backedUp ? 1 : 0, stored.id)
    return stored
  }

  const requestOptions = (c, creds) => ({
    challenge: c.challenge,
    rpId: c.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'required',
    allowCredentials: creds.map((x) => ({ type: 'public-key', id: x.id, transports: JSON.parse(x.transports) })),
  })

  /** Demande d'ajout de passkey par récupération (aucun passkey utilisable): délai de sécurité, annulable. */
  function recoveryGrant(s) {
    let open = db
      .prepare('SELECT * FROM passkey_grants WHERE account_id = ? AND scope = ? AND cancelled_at IS NULL AND confirmed_at IS NULL ORDER BY requested_at DESC LIMIT 1')
      .get(s.account_id, ENROLL_SCOPE)
    if (open?.issued_at && !(now() - open.issued_at <= REISSUE_MS && open.attempts < MAX_ATTEMPTS)) {
      db.prepare('UPDATE passkey_grants SET cancelled_at = ? WHERE id = ?').run(now(), open.id) // périmée: une nouvelle demande repart
      open = null
    }
    if (!open) {
      const id = newId()
      const readyAt = now() + delayMs
      db.prepare('INSERT INTO passkey_grants (id, account_id, scope, requested_at, ready_at) VALUES (?, ?, ?, ?, ?)').run(id, s.account_id, ENROLL_SCOPE, now(), readyAt)
      open = { id, ready_at: readyAt, issued_at: null, attempts: 0 }
      appendAudit(db, s.account_id, 'passkey.authorization_requested', { readyAt }, now())
    }
    if (open.ready_at > now()) return { pending: { status: 'pending', id: open.id, readyAt: open.ready_at, retryAfterSeconds: Math.ceil((open.ready_at - now()) / 1000) } }
    db.prepare('UPDATE passkey_grants SET issued_at = ?, attempts = attempts + 1 WHERE id = ?').run(now(), open.id)
    return { grant: { id: open.id, attempt: open.attempts + 1 } }
  }

  /** Autorisation de transfert encore valable: validée par la banque, pas expirée, pas déjà utilisée pour signer. */
  function clearedAuthorization(s, id) {
    const a = db.prepare('SELECT * FROM authorizations WHERE id = ? AND account_id = ?').get(String(id ?? ''), s.account_id)
    if (!a) throw new HttpError(404, 'not_found', 'Unknown authorization')
    if (a.status !== 'cleared') throw new HttpError(409, 'not_cleared', 'This transfer was not cleared by the bank')
    if (a.expires_at <= now()) throw new HttpError(410, 'expired', 'This authorization has expired')
    if (a.signing_at) throw new HttpError(409, 'authorization_used', 'This transfer was already authorized for signing')
    return a
  }

  /**
   * La banque remet au fournisseur de wallet l'autorisation de signer (ou d'exporter): un jeton court, à usage unique, que le
   * fournisseur exige pour coopérer. Pour un transfert, l'autorisation est consommée ici: une décision de la banque ne sert qu'une fois.
   */
  function mintAuthorization(s, action, binding, method) {
    const [kind, ref] = binding.split(':')
    if (kind === 'transfer') {
      const r = db.prepare("UPDATE authorizations SET signing_at = ? WHERE id = ? AND account_id = ? AND status = 'cleared' AND signing_at IS NULL AND expires_at > ?").run(now(), ref, s.account_id, now())
      if (!r.changes) throw new HttpError(409, 'authorization_used', 'This transfer was already authorized for signing, or has expired')
    }
    appendAudit(db, s.account_id, action === 'sign' ? 'signing.authorized' : 'export.authorized', { method, for: kind, ...(kind === 'transfer' && { authorizationId: ref }) }, now())
    return { method, assertion: signer.sign({ sub: `sq-${s.account_id}`, scope: ASSERTION_SCOPE[action] }, 120, now()) }
  }

  /* ------------------------------- routes ------------------------------- */

  const routes = {
    'GET /api/health': () => ({ ok: true, time: now() }),

    'POST /api/register': (req, res, body) => {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address')
      if (password.length < 10 || password.length > 200) throw new HttpError(400, 'weak_password', 'Use a password of 10 to 200 characters')
      if (!allowed.some((re) => re.test(email))) throw new HttpError(403, 'not_invited', 'This prototype is limited to invited email addresses')
      if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) throw new HttpError(409, 'email_taken', 'An account already exists for this email')
      const id = newId()
      const { salt, hash } = hashPassword(password)
      db.prepare('INSERT INTO accounts (id, email, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, salt, hash, now())
      appendAudit(db, id, 'account.created', { email }, now())
      res.setHeader('Set-Cookie', cookieHeader(startSession(id), config.sessionTtlSeconds))
      return { account: { id, email } }
    },

    'POST /api/login': (req, res, body) => {
      const email = String(body.email ?? '').trim().toLowerCase()
      const key = `${email}|${clientIp(req)}`
      throttle(key)
      const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email)
      if (!passwordMatches(account, body.password)) {
        recordFailure(key)
        if (account) appendAudit(db, account.id, 'session.failed', { reason: 'wrong password' }, now())
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect')
      }
      failures.delete(key)
      appendAudit(db, account.id, 'session.signin', {}, now())
      res.setHeader('Set-Cookie', cookieHeader(startSession(account.id), config.sessionTtlSeconds))
      return { account: { id: account.id, email: account.email } }
    },

    'POST /api/logout': (req, res) => {
      const s = sessionFrom(req)
      if (s) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash)
        appendAudit(db, s.account_id, 'session.signout', {}, now())
      }
      res.setHeader('Set-Cookie', cookieHeader('', 0))
      return { ok: true }
    },

    'GET /api/me': (req) => {
      const s = requireSession(req)
      return { account: { id: s.account_id, email: s.email }, reauthFresh: now() - s.reauth_at <= reauthMs, strongFresh: strongFresh(s), passkeys: activeCredentials(s.account_id).length }
    },

    // Jeton de connexion pour le fournisseur de wallet. Même identifiant (`sub`) que les assertions.
    'POST /api/local/login': (req) => {
      const s = requireSession(req)
      appendAudit(db, s.account_id, 'wallet.login_token', {}, now())
      return { jwt: signer.sign({ sub: `sq-${s.account_id}`, email: s.email, emailVerified: true }, 300, now()) }
    },

    /* ---------------- passkeys gérés par la banque ---------------- */

    // Inscription d'un passkey. Le premier est immédiat. Ensuite: immédiat si un passkey vient d'être vérifié sur cette session
    // (on ajoute un second appareil), sinon c'est une récupération (appareil perdu) et elle passe par un délai de sécurité.
    'POST /api/passkeys/register/options': (req, res, body) => {
      const s = requireSession(req)
      ensureFresh(s, body, 'passkey.register')
      const origin = originOf(req)
      const creds = activeCredentials(s.account_id)
      const mode = creds.length === 0 ? 'first' : strongFresh(s) ? 'proven' : 'recovery'
      let binding = mode
      if (mode === 'recovery') {
        const outcome = recoveryGrant(s)
        if (outcome.pending) {
          res.statusCode = 202
          return outcome.pending
        }
        binding = `grant:${outcome.grant.id}`
        appendAudit(db, s.account_id, 'passkey.authorized', { mode, attempt: outcome.grant.attempt }, now())
      } else {
        appendAudit(db, s.account_id, 'passkey.authorized', { mode }, now())
      }
      const c = issueChallenge({ purpose: 'register', accountId: s.account_id, sessionHash: s.token_hash, binding, origin })
      return {
        status: 'ready',
        mode,
        challengeId: c.id,
        publicKey: {
          rp: { id: c.rpId, name: 'equinox (test bank)' },
          user: { id: b64u.encode(s.account_id), name: s.email, displayName: s.email },
          challenge: c.challenge,
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: CEREMONY_TIMEOUT_MS,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          excludeCredentials: creds.filter((x) => x.rp_id === c.rpId).map((x) => ({ type: 'public-key', id: x.id, transports: JSON.parse(x.transports) })),
        },
      }
    },

    'POST /api/passkeys/register/verify': (req, res, body) => {
      const { row, s } = takeChallenge(req, body.challengeId, ['register'])
      let reg
      try {
        reg = verifyRegistration({ credential: body.credential, expectedChallenge: b64u.decode(row.challenge), allowedOrigins: [row.origin], rpId: row.rp_id })
      } catch (e) {
        passkeyError(e, s.account_id)
      }
      if (db.prepare('SELECT 1 FROM webauthn_credentials WHERE id = ?').get(reg.credentialId)) throw new HttpError(409, 'passkey_exists', 'This passkey is already registered')
      const transports = Array.isArray(body.credential?.response?.transports) ? body.credential.response.transports.filter((x) => typeof x === 'string').slice(0, 8) : []
      const label = cleanLabel(body.label)
      const t = now()
      db.exec('BEGIN')
      try {
        db.prepare(
          'INSERT INTO webauthn_credentials (id, account_id, rp_id, public_key, alg, sign_count, transports, backup_eligible, backed_up, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(reg.credentialId, s.account_id, row.rp_id, JSON.stringify(reg.jwk), reg.alg, reg.signCount, JSON.stringify(transports), reg.backupEligible ? 1 : 0, reg.backedUp ? 1 : 0, label, t)
        if (row.binding?.startsWith('grant:')) db.prepare('UPDATE passkey_grants SET confirmed_at = ? WHERE id = ?').run(t, row.binding.slice(6))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      markStrong(s) // la cérémonie d'inscription a vérifié l'utilisateur
      appendAudit(db, s.account_id, 'passkey.registered', { label, mode: row.binding?.split(':')[0], synced: reg.backedUp }, t)
      return { passkey: describeCredential(db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(reg.credentialId)) }
    },

    'GET /api/passkeys': (req) => {
      const s = requireSession(req)
      return { passkeys: activeCredentials(s.account_id).map(describeCredential), strongFresh: strongFresh(s) }
    },

    // Prouver sa présence avec un passkey (avant d'ajouter ou de retirer un passkey), ou se connecter SANS mot de passe.
    'POST /api/passkeys/auth/options': (req, res, body) => {
      const purpose = String(body.purpose ?? '')
      const origin = originOf(req)
      if (purpose === 'login') {
        const c = issueChallenge({ purpose, origin })
        return { challengeId: c.id, publicKey: requestOptions(c, []) }
      }
      if (purpose === 'manage') {
        const s = requireSession(req)
        const creds = activeCredentials(s.account_id).filter((x) => x.rp_id === rpIdOf(origin))
        if (creds.length === 0) throw new HttpError(409, 'no_passkey_here', 'None of your passkeys works at this address')
        const c = issueChallenge({ purpose, accountId: s.account_id, sessionHash: s.token_hash, origin })
        return { challengeId: c.id, publicKey: requestOptions(c, creds) }
      }
      throw new HttpError(400, 'invalid_purpose', 'Unknown request')
    },

    'POST /api/passkeys/auth/verify': (req, res, body) => {
      const { row, s } = takeChallenge(req, body.challengeId, ['login', 'manage'])
      const cred = checkAssertion(row, body.credential)
      if (row.purpose === 'login') {
        const account = db.prepare('SELECT id, email FROM accounts WHERE id = ?').get(cred.account_id)
        res.setHeader('Set-Cookie', cookieHeader(startSession(account.id, { strong: true }), config.sessionTtlSeconds))
        appendAudit(db, account.id, 'session.passkey_login', { label: cred.label }, now())
        return { account: { id: account.id, email: account.email } }
      }
      markStrong(s)
      appendAudit(db, s.account_id, 'passkey.verified', { label: cred.label }, now())
      return { ok: true }
    },

    // Retirer un passkey: il faut en avoir vérifié un à l'instant, et il en reste toujours au moins un.
    'POST /api/passkeys/remove': (req, res, body) => {
      const s = requireSession(req)
      if (!strongFresh(s)) throw new HttpError(401, 'passkey_required', 'Confirm with a passkey first')
      const creds = activeCredentials(s.account_id)
      const target = creds.find((c) => c.id === String(body.id ?? ''))
      if (!target) throw new HttpError(404, 'not_found', 'No such passkey')
      if (creds.length <= 1) throw new HttpError(409, 'last_passkey', 'Keep at least one passkey. Add another one first.')
      db.prepare('UPDATE webauthn_credentials SET removed_at = ? WHERE id = ?').run(now(), target.id)
      appendAudit(db, s.account_id, 'passkey.removed', { label: target.label }, now())
      return { ok: true }
    },

    'POST /api/passkeys/requests/cancel': (req, res, body) => {
      const s = requireSession(req)
      const r = db.prepare('UPDATE passkey_grants SET cancelled_at = ? WHERE id = ? AND account_id = ? AND issued_at IS NULL AND cancelled_at IS NULL').run(now(), String(body.id ?? ''), s.account_id)
      if (!r.changes) throw new HttpError(404, 'not_found', 'No pending request with this identifier')
      appendAudit(db, s.account_id, 'passkey.authorization_cancelled', { id: body.id }, now())
      return { ok: true }
    },

    /* ------ autorisations remises au fournisseur de wallet (sans elles il refuse de signer ou d'exporter) ------ */

    // Signer: avec un passkey (si le compte en a), lié au transfert que la banque a validé; sinon avec le mot de passe.
    // Exporter la clé: toujours avec un passkey.
    'POST /api/authorize/begin': (req, res, body) => {
      const s = requireSession(req)
      const action = String(body.action ?? '')
      if (!(action in ASSERTION_SCOPE)) throw new HttpError(400, 'invalid_action', 'This authorization is not available')
      const origin = originOf(req)
      let binding = 'export'
      if (action === 'sign') binding = body.authorizationId ? `transfer:${clearedAuthorization(s, body.authorizationId).id}` : `proof:${newId()}`

      const all = activeCredentials(s.account_id)
      if (all.length > 0) {
        const here = all.filter((x) => x.rp_id === rpIdOf(origin))
        if (here.length === 0) throw new HttpError(409, 'no_passkey_here', 'None of your passkeys works at this address. Add one first.')
        const c = issueChallenge({ purpose: action, accountId: s.account_id, sessionHash: s.token_hash, binding, origin })
        return { method: 'passkey', challengeId: c.id, publicKey: requestOptions(c, here) }
      }
      if (action === 'export') throw new HttpError(409, 'no_passkey', 'Add a passkey first: it is required to export your key')
      ensureFresh(s, body, ASSERTION_SCOPE.sign)
      return mintAuthorization(s, action, binding, 'password')
    },

    'POST /api/authorize/finish': (req, res, body) => {
      const { row, s } = takeChallenge(req, body.challengeId, ['sign', 'export'])
      const cred = checkAssertion(row, body.credential)
      markStrong(s)
      const out = mintAuthorization(s, row.purpose, row.binding ?? '', 'passkey')
      db.prepare('UPDATE webauthn_credentials SET last_used_at = ? WHERE id = ?').run(now(), cred.id)
      return out
    },

    // Demandes de nouveau passkey en attente: à afficher sur les autres appareils connectés du client.
    'GET /api/notifications': (req) => {
      const s = requireSession(req)
      const rows = db
        .prepare('SELECT id, scope, requested_at, ready_at FROM passkey_grants WHERE account_id = ? AND issued_at IS NULL AND cancelled_at IS NULL ORDER BY requested_at DESC')
        .all(s.account_id)
      return { pendingPasskeyRequests: rows.map((r) => ({ id: r.id, scope: r.scope, requestedAt: r.requested_at, readyAt: r.ready_at })) }
    },

    'GET /api/policy': (req) => {
      const s = requireSession(req)
      const row = db.prepare('SELECT json FROM policies WHERE account_id = ?').get(s.account_id)
      return { policy: row ? JSON.parse(row.json) : defaultPolicy() }
    },

    'PUT /api/policy': (req, res, body) => {
      const s = requireSession(req)
      const policy = validatePolicy(body.policy)
      db.prepare('INSERT INTO policies (account_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(
        s.account_id,
        JSON.stringify(policy),
        now(),
      )
      appendAudit(db, s.account_id, 'rules.updated', { maxPerTx: policy.maxPerTx, maxPerDay: policy.maxPerDay, blockUnknownDestinations: policy.blockUnknownDestinations }, now())
      return { policy }
    },

    // La banque regarde le transfert AVANT que le client ne signe: limites et liste approuvée.
    'POST /api/transfers/check': (req, res, body) => {
      const s = requireSession(req)
      const { chain, to, amount } = body
      if (!CHAINS.includes(chain)) throw new HttpError(400, 'invalid_chain', 'Unknown network')
      if (!isValidAddress(chain, to)) throw new HttpError(400, 'invalid_address', `Not a valid ${chain} test-network address`)
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'invalid_amount', 'Amount must be a positive number')

      const row = db.prepare('SELECT json FROM policies WHERE account_id = ?').get(s.account_id)
      const policy = row ? JSON.parse(row.json) : defaultPolicy()
      // Ce qui compte dans le plafond de 24 h: ce qui est parti, ce qui a été autorisé pour signer (même si le client n'en rapporte pas
      // l'issue, ou annonce un échec), et les décisions encore valables, réservées. Une décision jamais utilisée et expirée est libérée:
      // contrôler un transfert n'est pas le dépenser.
      const spent = db
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM authorizations WHERE account_id = ? AND chain = ? AND created_at > ? AND status != 'refused' AND (signing_at IS NOT NULL OR status = 'broadcast' OR (status = 'cleared' AND expires_at > ?))",
        )
        .get(s.account_id, chain, now() - 24 * 3_600_000, now()).total
      const verdict = evaluate(policy, { chain, to, amount }, spent)
      const allowedNow = verdict.allowed
      const reasons = verdict.reasons
      const id = newId()
      const t = now()
      db.prepare('INSERT INTO authorizations (id, account_id, chain, to_addr, amount, status, reasons, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        s.account_id,
        chain,
        normalizeAddress(chain, to),
        amount,
        allowedNow ? 'cleared' : 'refused',
        JSON.stringify(reasons),
        t,
        t + TRANSFER_TTL_MS,
      )
      appendAudit(db, s.account_id, allowedNow ? 'transfer.cleared' : 'transfer.refused', { chain, to, amount, reasons: allowedNow ? [] : reasons }, t)
      return {
        allowed: allowedNow,
        reasons,
        authorizationId: allowedNow ? id : undefined,
        expiresAt: allowedNow ? t + TRANSFER_TTL_MS : undefined,
      }
    },

    // Le client indique le résultat de la diffusion, pour que l'audit relie décision et transaction.
    'POST /api/transfers/report': (req, res, body) => {
      const s = requireSession(req)
      const row = db.prepare('SELECT * FROM authorizations WHERE id = ? AND account_id = ?').get(String(body.authorizationId ?? ''), s.account_id)
      if (!row) throw new HttpError(404, 'not_found', 'Unknown authorization')
      if (row.status !== 'cleared') throw new HttpError(409, 'not_cleared', 'This transfer was not cleared by the bank')
      if (row.expires_at <= now()) throw new HttpError(410, 'expired', 'This authorization has expired')
      if (typeof body.hash === 'string' && body.hash.length > 0 && body.hash.length <= 200) {
        if (body.from !== undefined && !isValidAddress(row.chain, body.from)) {
          throw new HttpError(400, 'invalid_address', `Not a valid ${row.chain} test-network address`)
        }
        if (body.from) chain.recordTransfer({ chain: row.chain, from: body.from, to: row.to_addr, amount: row.amount, hash: body.hash })
        db.prepare("UPDATE authorizations SET status = 'broadcast', tx_hash = ? WHERE id = ?").run(body.hash, row.id)
        appendAudit(db, s.account_id, body.from ? 'transfer.simulated' : 'transfer.broadcast', { chain: row.chain, to: row.to_addr, amount: row.amount, hash: body.hash }, now())
      } else {
        db.prepare("UPDATE authorizations SET status = 'failed' WHERE id = ?").run(row.id)
        appendAudit(db, s.account_id, 'transfer.failed', { chain: row.chain, to: row.to_addr, amount: row.amount, error: String(body.error ?? 'unknown').slice(0, 200) }, now())
      }
      return { ok: true }
    },

    'GET /api/audit': (req) => {
      const s = requireSession(req)
      return { entries: listAudit(db, s.account_id, 100), integrity: verifyAudit(db, s.account_id) }
    },
  }

  /* -------------------------------- HTTP -------------------------------- */

  return async function handle(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      const chainRead = req.method === 'GET' ? CHAIN_PATH.exec(path) : null
      const route = chainRead
        ? () => {
            const s = requireSession(req)
            if (!isValidAddress(chainRead[1], chainRead[2])) throw new HttpError(400, 'invalid_address', `Not a valid ${chainRead[1]} test-network address`)
            return chain.read(chainRead[1], chainRead[2])
          }
        : routes[`${req.method} ${path}`]
      if (!route) throw new HttpError(404, 'not_found', 'Unknown route')
      let body = {}
      if (req.method !== 'GET') {
        // Anti-CSRF: seule l'origine de l'application peut modifier l'état, et uniquement en JSON.
        if (!config.allowedOrigins.includes(req.headers.origin)) throw new HttpError(403, 'bad_origin', 'Request origin is not allowed')
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'bad_content_type', 'Use application/json')
        body = await readJson(req)
      }
      const result = await route(req, res, body)
      res.end(JSON.stringify(result))
    } catch (e) {
      const known = e instanceof HttpError || e instanceof PolicyError || e instanceof ChainError
      const status = e instanceof HttpError ? e.status : e instanceof PolicyError ? 400 : e instanceof ChainError ? 502 : 500
      if (status === 500) console.error('[bank] internal error:', e)
      res.statusCode = status
      res.end(JSON.stringify({ error: { code: known ? e.code : 'internal', message: known ? e.message : 'Internal error' } }))
    }
  }
}
