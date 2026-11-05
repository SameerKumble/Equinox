import { BankApiError } from '../access/errors'
import type { AuthorizeAction, AuthorizeStart, BankAuthority, BankPasskey, CreationOptions, EnrollStart, RequestOptions } from '../bank/authority'
import { fakeToken } from './fakeWallet'

/* Double de test de la banque. Reproduit les règles du vrai backend (server/):
   - le premier passkey est immédiat; un second l'est si un passkey vient d'être vérifié (preuve forte); sinon c'est une
     récupération (appareil perdu), avec un délai de sécurité, une courte fenêtre de nouvel essai, et la possibilité d'annuler;
   - signer: avec un passkey (si le compte en a), lié au transfert validé, qui ne sert qu'une fois; sinon avec le mot de passe;
   - exporter la clé: toujours un passkey;
   - retirer un passkey: preuve forte, et il en reste toujours un.
   Le vrai backend a ses propres tests, cryptographie comprise; ici on vérifie que les parcours du produit se comportent
   bien face à ces règles. */

const REISSUE_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const STRONG_MS = 10 * 60_000

export type FakeBankOptions = { email: string; delayMs?: number; passwordFor?: string; now?: () => number }

type Credential = { id: string; challenge?: string; userId?: string }
type Grant = { id: string; requestedAt: number; readyAt: number; issuedAt: number | null; attempts: number }
type Challenge = { purpose: 'register' | 'login' | 'manage' | 'sign' | 'export'; challenge: string; binding?: string; grantId?: string }
type Passkey = BankPasskey

export type FakeBank = BankAuthority & {
  /** Passkeys enregistrés. */
  readonly enrolled: Passkey[]
  /** Autorisations de signer remises (et l'identifiant de transfert auquel chacune était liée, s'il y en a un). */
  readonly signed: { method: 'passkey' | 'password'; authorizationId?: string }[]
  /** Autorisations d'export remises. */
  readonly exported: number
  /** Connexions par passkey réussies. */
  readonly logins: number
  /** Une preuve forte (passkey) est-elle fraîche? */
  strongFresh(): boolean
  /** Fait expirer la preuve forte (le temps a passé depuis le dernier passkey vérifié). */
  expireStrong(): void
  /** Demandes en attente de leur délai (ce que la banque montre sur les autres appareils). */
  pendingRequests(): { id: string; scope: 'passkey:enroll'; requestedAt: number; readyAt: number }[]
  cancel(id: string): void
}

export function fakeBank(opts: FakeBankOptions): FakeBank {
  const now = opts.now ?? Date.now
  const delay = opts.delayMs ?? 60_000
  const state = {
    passkeys: [] as Passkey[],
    strongAt: null as number | null,
    challenges: new Map<string, Challenge>(),
    grant: null as Grant | null,
    signed: [] as { method: 'passkey' | 'password'; authorizationId?: string }[],
    exported: 0,
    usedAuthorizations: new Set<string>(),
    seq: 0,
    logins: 0,
  }
  const strongFresh = () => state.strongAt !== null && now() - state.strongAt <= STRONG_MS
  const token = () => `${now()}-${++state.seq}`
  const ensureFresh = (password?: string) => {
    if (opts.passwordFor === undefined || strongFresh()) return
    if (password !== opts.passwordFor) throw new BankApiError(401, 'reauth_required', password === undefined ? 'Enter your password again to continue' : 'Password is incorrect')
  }
  const issue = (c: Omit<Challenge, 'challenge'>): { id: string; challenge: string } => {
    const id = `ch-${token()}`
    const challenge = `chal-${token()}`
    state.challenges.set(id, { ...c, challenge })
    return { id, challenge }
  }
  const take = (id: string, purposes: Challenge['purpose'][], credential: Credential): Challenge => {
    const c = state.challenges.get(id)
    state.challenges.delete(id) // un défi ne sert qu'une fois
    if (!c || !purposes.includes(c.purpose)) throw new BankApiError(400, 'invalid_challenge', 'This request has expired. Start again.')
    if (credential.challenge !== c.challenge) throw new BankApiError(401, 'invalid_passkey', 'This passkey could not be verified')
    return c
  }
  const allow = () => state.passkeys.map((p) => ({ type: 'public-key' as const, id: p.id, transports: ['internal'] }))
  const requestOptions = (challenge: string, creds = allow()): RequestOptions => ({ challenge, rpId: 'localhost', userVerification: 'required', allowCredentials: creds })
  const known = (credential: Credential): Passkey => {
    const p = state.passkeys.find((x) => x.id === credential.id)
    if (!p) throw new BankApiError(401, 'invalid_passkey', 'This passkey could not be verified')
    p.lastUsedAt = now()
    return p
  }

  /** Récupération: délai de sécurité, même demande tant qu'il court, fenêtre de nouvel essai, abandon après trois essais. */
  const recovery = (): { pending: EnrollStart } | { grantId: string } => {
    let g = state.grant
    if (g?.issuedAt != null && !(now() - g.issuedAt <= REISSUE_MS && g.attempts < MAX_ATTEMPTS)) g = state.grant = null
    g ??= state.grant = { id: `req-${token()}`, requestedAt: now(), readyAt: now() + delay, issuedAt: null, attempts: 0 }
    if (g.readyAt > now()) return { pending: { status: 'pending', id: g.id, readyAt: g.readyAt, retryAfterSeconds: Math.ceil((g.readyAt - now()) / 1000) } }
    g.issuedAt = now()
    g.attempts++
    return { grantId: g.id }
  }

  return {
    get enrolled() {
      return state.passkeys
    },
    get signed() {
      return state.signed
    },
    get exported() {
      return state.exported
    },
    get logins() {
      return state.logins
    },
    strongFresh,
    expireStrong: () => void (state.strongAt = null),

    pendingRequests() {
      const g = state.grant
      return g && g.issuedAt === null ? [{ id: g.id, scope: 'passkey:enroll' as const, requestedAt: g.requestedAt, readyAt: g.readyAt }] : []
    },
    cancel(id) {
      if (state.grant?.id !== id || state.grant.issuedAt !== null) throw new BankApiError(404, 'not_found', 'No pending request with this identifier')
      state.grant = null
    },

    async loginToken() {
      return fakeToken({ email: opts.email })
    },

    async passkeys() {
      return state.passkeys.map((p) => ({ ...p }))
    },

    async registerOptions(password) {
      ensureFresh(password)
      const mode = state.passkeys.length === 0 ? 'first' : strongFresh() ? 'proven' : 'recovery'
      let grantId: string | undefined
      if (mode === 'recovery') {
        const r = recovery()
        if ('pending' in r) return r.pending
        grantId = r.grantId
      }
      const c = issue({ purpose: 'register', grantId })
      const publicKey: CreationOptions = {
        rp: { id: 'localhost', name: 'equinox (test bank)' },
        user: { id: 'acc-1', name: opts.email, displayName: opts.email },
        challenge: c.challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: allow(),
      }
      return { status: 'ready', mode, challengeId: c.id, publicKey }
    },

    async registerVerify({ challengeId, credential, label }) {
      const cred = credential as Credential
      const c = take(challengeId, ['register'], cred)
      if (state.passkeys.some((p) => p.id === cred.id)) throw new BankApiError(409, 'passkey_exists', 'This passkey is already registered')
      const passkey: Passkey = { id: cred.id, label, createdAt: now(), lastUsedAt: null, synced: false }
      state.passkeys.push(passkey)
      if (c.grantId && state.grant?.id === c.grantId) state.grant = null // la demande est menée à terme
      state.strongAt = now()
      return { passkey: { ...passkey } }
    },

    async authOptions(purpose) {
      if (purpose === 'manage' && state.passkeys.length === 0) throw new BankApiError(409, 'no_passkey_here', 'None of your passkeys works at this address')
      const c = issue({ purpose })
      return { challengeId: c.id, publicKey: requestOptions(c.challenge, purpose === 'login' ? [] : allow()) }
    },

    async authVerify({ challengeId, credential }) {
      const cred = credential as Credential
      const c = take(challengeId, ['login', 'manage'], cred)
      known(cred)
      state.strongAt = now()
      if (c.purpose === 'login') state.logins++
      return { ok: true }
    },

    async removePasskey(id) {
      if (!strongFresh()) throw new BankApiError(401, 'passkey_required', 'Confirm with a passkey first')
      if (state.passkeys.length <= 1) throw new BankApiError(409, 'last_passkey', 'Keep at least one passkey. Add another one first.')
      const i = state.passkeys.findIndex((p) => p.id === id)
      if (i < 0) throw new BankApiError(404, 'not_found', 'No such passkey')
      state.passkeys.splice(i, 1)
      return { ok: true }
    },

    async authorizeBegin({ action, authorizationId, password }): Promise<AuthorizeStart> {
      if (authorizationId && state.usedAuthorizations.has(authorizationId)) throw new BankApiError(409, 'authorization_used', 'This transfer was already authorized for signing')
      if (action === 'export' && state.passkeys.length === 0) throw new BankApiError(409, 'no_passkey', 'Add a passkey first: it is required to export your key')
      if (state.passkeys.length > 0) {
        const c = issue({ purpose: action, binding: authorizationId })
        return { method: 'passkey', challengeId: c.id, publicKey: requestOptions(c.challenge) }
      }
      ensureFresh(password)
      if (authorizationId) state.usedAuthorizations.add(authorizationId)
      state.signed.push({ method: 'password', authorizationId })
      return { method: 'password', assertion: fakeToken({ email: opts.email, scope: 'wallet:sign' }) }
    },

    async authorizeFinish({ challengeId, credential }) {
      const cred = credential as Credential
      const c = take(challengeId, ['sign', 'export'], cred)
      known(cred)
      state.strongAt = now()
      const action: AuthorizeAction = c.purpose as AuthorizeAction
      if (action === 'sign') {
        if (c.binding) {
          if (state.usedAuthorizations.has(c.binding)) throw new BankApiError(409, 'authorization_used', 'This transfer was already authorized for signing, or has expired')
          state.usedAuthorizations.add(c.binding)
        }
        state.signed.push({ method: 'passkey', authorizationId: c.binding })
        return { assertion: fakeToken({ email: opts.email, scope: 'wallet:sign' }) }
      }
      state.exported++
      return { assertion: fakeToken({ email: opts.email, scope: 'wallet:export' }) }
    },
  }
}
