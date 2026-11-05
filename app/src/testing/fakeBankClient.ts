import { BankApiError } from '../access/errors'
import type { AuditEntry, BankClient, ChainData, Policy, TransferVerdict } from '../bank/api'
import type { Chain } from '../provider/types'
import { fakeBank, type FakeBank } from './fakeBank'

/* Double de test du CLIENT de la banque (tout ce que l'interface appelle sur /api). Il s'appuie sur `fakeBank` pour les règles
   de passkey et garde en mémoire la politique, l'audit, les contrôles de transfert et les données de chaîne. Il sert à faire
   tourner les vrais écrans dans les tests; les règles réelles de la banque sont testées dans server/. */

const UNIT: Record<Chain, string> = { BTC: 'BTC', EVM: 'ETH', SOL: 'SOL' }

export const defaultTestPolicy = (): Policy => ({
  maxPerTx: { BTC: 0.01, EVM: 1, SOL: 10 },
  maxPerDay: { BTC: 0.05, EVM: 5, SOL: 50 },
  allowlist: { BTC: [], EVM: [], SOL: [] },
  blockUnknownDestinations: false,
})

export type FakeBankClientOptions = { email: string; signedIn?: boolean; now?: () => number; delayMs?: number; passwordFor?: string }

export function fakeBankClient(opts: FakeBankClientOptions) {
  const now = opts.now ?? Date.now
  const rules: FakeBank = fakeBank({ email: opts.email, now, delayMs: opts.delayMs, passwordFor: opts.passwordFor })
  const state = {
    session: opts.signedIn ? { email: opts.email } : (null as { email: string } | null),
    policy: defaultTestPolicy(),
    audit: [] as AuditEntry[],
    checks: [] as { chain: Chain; to: string; amount: number }[],
    reports: [] as { authorizationId: string; hash?: string; error?: string }[],
    chain: {} as Partial<Record<Chain, Partial<ChainData>>>,
    logins: 0,
  }
  const log = (action: string, detail: Record<string, unknown> = {}) =>
    state.audit.unshift({ seq: state.audit.length + 1, at: now(), action, detail, hash: `h${state.audit.length + 1}` })
  const signedIn = () => {
    if (!state.session) throw new BankApiError(401, 'unauthenticated', 'Sign in to your bank account first')
  }

  const client: BankClient = {
    async me() {
      return state.session ? { account: { id: 'acc-1', email: state.session.email }, reauthFresh: true, strongFresh: rules.strongFresh(), passkeys: rules.enrolled.length } : null
    },
    async register(email, password) {
      if (password.length < 10) throw new BankApiError(400, 'weak_password', 'Use a password of 10 to 200 characters')
      state.session = { email }
      log('account.created', { email })
      return { account: { id: 'acc-1', email } }
    },
    async login(email, password) {
      if (password !== 'right password') throw new BankApiError(401, 'invalid_credentials', 'Email or password is incorrect')
      state.session = { email }
      state.logins++
      log('session.signin')
      return { account: { id: 'acc-1', email } }
    },
    async logout() {
      state.session = null
      return { ok: true as const }
    },
    async loginToken() {
      signedIn()
      return rules.loginToken()
    },
    async passkeys() {
      signedIn()
      return rules.passkeys()
    },
    async registerOptions(password) {
      signedIn()
      const start = await rules.registerOptions(password)
      if (start.status === 'pending') log('passkey.authorization_requested', { readyAt: start.readyAt })
      else log('passkey.authorized', { mode: start.mode })
      return start
    },
    async registerVerify(r) {
      signedIn()
      const out = await rules.registerVerify(r)
      log('passkey.registered', { label: r.label })
      return out
    },
    async authOptions(purpose) {
      if (purpose === 'manage') signedIn()
      return rules.authOptions(purpose)
    },
    async authVerify(r) {
      const before = rules.logins
      const out = await rules.authVerify(r)
      if (rules.logins > before) {
        // Connexion par passkey: la banque ouvre la session du client.
        state.session = { email: opts.email }
        log('session.passkey_login')
      } else {
        signedIn()
        log('passkey.verified')
      }
      return out
    },
    async removePasskey(id) {
      signedIn()
      const out = await rules.removePasskey(id)
      log('passkey.removed', { id })
      return out as { ok: true }
    },
    async cancelRequest(id) {
      signedIn()
      rules.cancel(id)
      log('passkey.authorization_cancelled', { id })
      return { ok: true as const }
    },
    async authorizeBegin(r) {
      signedIn()
      const out = await rules.authorizeBegin(r)
      if (out.method === 'password') log(r.action === 'sign' ? 'signing.authorized' : 'export.authorized', { method: 'password' })
      return out
    },
    async authorizeFinish(r) {
      signedIn()
      const out = await rules.authorizeFinish(r)
      const scope = JSON.parse(atob(out.assertion.slice(5))).scope as string
      log(scope === 'wallet:export' ? 'export.authorized' : 'signing.authorized', { method: 'passkey' })
      return out
    },
    async pendingRequests() {
      signedIn()
      return rules.pendingRequests()
    },
    async policy() {
      signedIn()
      return structuredClone(state.policy)
    },
    async savePolicy(policy) {
      signedIn()
      state.policy = structuredClone(policy)
      log('rules.updated')
      return structuredClone(policy)
    },
    async checkTransfer(t): Promise<TransferVerdict> {
      signedIn()
      state.checks.push(t)
      const reasons: string[] = []
      if (t.amount > state.policy.maxPerTx[t.chain]) reasons.push(`Limit per transfer exceeded (${t.amount} > ${state.policy.maxPerTx[t.chain]} ${t.chain})`)
      if (reasons.length) {
        log('transfer.refused', { ...t, reasons })
        return { allowed: false, reasons }
      }
      log('transfer.cleared', t)
      return { allowed: true, reasons: ['Within your limits'], authorizationId: `auth-${state.checks.length}`, expiresAt: now() + 10 * 60_000 }
    },
    async reportTransfer(r) {
      signedIn()
      state.reports.push(r)
      log(r.hash ? 'transfer.broadcast' : 'transfer.failed', r)
      return { ok: true as const }
    },
    async audit() {
      signedIn()
      return { entries: state.audit, integrity: { ok: true, count: state.audit.length } }
    },
    async readChain(chain, address) {
      signedIn()
      return { chain, address, unit: UNIT[chain], balance: 0, txs: [], estimatedFee: 0.00001, source: 'fake', fetchedAt: now(), ...state.chain[chain] }
    },
  }
  return Object.assign(client, { rules, state })
}
