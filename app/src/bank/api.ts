import { BankApiError, BankUnavailableError } from '../access/errors'
import type { Chain } from '../provider/types'
import type { AuthorizeAction, AuthorizeStart, BankAuthority, BankPasskey, EnrollStart, RequestOptions } from './authority'

/* Client du backend de la banque. Tout passe par /api, sur la même origine que l'application: le cookie de session
   est HttpOnly (illisible par le code de la page) et le backend refuse toute autre origine pour les écritures.
   Aucune clé, aucun secret ici. */

export type Policy = {
  maxPerTx: Record<Chain, number>
  maxPerDay: Record<Chain, number>
  allowlist: Record<Chain, string[]>
  blockUnknownDestinations: boolean
}

export type AuditEntry = { seq: number; at: number; action: string; detail: Record<string, unknown>; hash: string }
export type AuditIntegrity = { ok: boolean; count: number; brokenAtSeq?: number }
/** Demande d'ajout de passkey (récupération) en attente de son délai de sécurité. */
export type PendingRequest = { id: string; scope: string; requestedAt: number; readyAt: number }
export type TransferVerdict = { allowed: boolean; reasons: string[]; authorizationId?: string; expiresAt?: number }
export type BankAccount = { id: string; email: string }

/** Une transaction vue par l'adresse du client. `amount` est ce qui a changé de mains (hors frais), dans l'unité de la chaîne. */
export type ChainTx = {
  hash: string
  time: number | null
  confirmed: boolean
  ok: boolean
  direction: 'in' | 'out' | 'self'
  amount: number
  fee: number | null
  counterparty: string | null
  unknown?: boolean
}
export type ChainData = {
  chain: Chain
  address: string
  unit: string
  balance: number
  txs: ChainTx[]
  /** Estimation des frais d'un transfert simple, dans l'unité de la chaîne. */
  estimatedFee: number | null
  source: string
  fetchedAt: number
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
  } catch (e) {
    throw new BankUnavailableError(e instanceof Error ? e.message : undefined)
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null
  if (!res.ok) {
    // Une réponse qui n'est pas du JSON de la banque (page d'erreur d'un proxy, tunnel coupé): la banque est injoignable.
    if (!json?.error) throw new BankUnavailableError(`HTTP ${res.status}`)
    throw new BankApiError(res.status, json.error.code, json.error.message)
  }
  return json as T
}

export const bankApi = {
  /** Session de banque en cours, ou null. */
  async me(): Promise<{ account: BankAccount; reauthFresh: boolean; strongFresh: boolean; passkeys: number } | null> {
    try {
      return await call('GET', '/me')
    } catch (e) {
      if (e instanceof BankApiError && e.status === 401) return null
      throw e
    }
  },
  register: (email: string, password: string) => call<{ account: BankAccount }>('POST', '/register', { email, password }),
  login: (email: string, password: string) => call<{ account: BankAccount }>('POST', '/login', { email, password }),
  logout: () => call<{ ok: true }>('POST', '/logout'),

  /** Jeton local utilisé pour associer la session bancaire au wallet simulé. */
  async loginToken(): Promise<string> {
    return (await call<{ jwt: string }>('POST', '/local/login')).jwt
  },

  /** Passkeys enregistrés auprès de la banque. */
  async passkeys(): Promise<BankPasskey[]> {
    return (await call<{ passkeys: BankPasskey[] }>('GET', '/passkeys')).passkeys
  },
  /** Ajout d'un passkey: immédiat (premier, ou second après preuve), ou après un délai de sécurité (appareil perdu). */
  async registerOptions(password?: string): Promise<EnrollStart> {
    return call<EnrollStart>('POST', '/passkeys/register/options', { password })
  },
  registerVerify: (r: { challengeId: string; credential: unknown; label: string }) => call<{ passkey: BankPasskey }>('POST', '/passkeys/register/verify', r),
  authOptions: (purpose: 'login' | 'manage') => call<{ challengeId: string; publicKey: RequestOptions }>('POST', '/passkeys/auth/options', { purpose }),
  authVerify: (r: { challengeId: string; credential: unknown }) => call<unknown>('POST', '/passkeys/auth/verify', r),
  removePasskey: (id: string) => call<{ ok: true }>('POST', '/passkeys/remove', { id }),
  cancelRequest: (id: string) => call<{ ok: true }>('POST', '/passkeys/requests/cancel', { id }),

  /** La banque autorise une signature (ou l'export de la clé) auprès du fournisseur: avec un passkey si le client en a, sinon avec son mot de passe. */
  authorizeBegin: (r: { action: AuthorizeAction; authorizationId?: string; password?: string }) => call<AuthorizeStart>('POST', '/authorize/begin', r),
  authorizeFinish: (r: { challengeId: string; credential: unknown }) => call<{ assertion: string }>('POST', '/authorize/finish', r),
  async pendingRequests(): Promise<PendingRequest[]> {
    return (await call<{ pendingPasskeyRequests: PendingRequest[] }>('GET', '/notifications')).pendingPasskeyRequests
  },

  async policy(): Promise<Policy> {
    return (await call<{ policy: Policy }>('GET', '/policy')).policy
  },
  async savePolicy(policy: Policy): Promise<Policy> {
    return (await call<{ policy: Policy }>('PUT', '/policy', { policy })).policy
  },

  /** La banque regarde le transfert AVANT que le client ne signe: limites et liste approuvée. */
  checkTransfer: (t: { chain: Chain; to: string; amount: number }) => call<TransferVerdict>('POST', '/transfers/check', t),
  /** Indique à la banque ce qui s'est passé après sa décision (hash diffusé, ou erreur), pour que l'audit relie les deux. */
  reportTransfer: (r: { authorizationId: string; hash?: string; error?: string; from?: string }) => call<{ ok: true }>('POST', '/transfers/report', r),

  audit: () => call<{ entries: AuditEntry[]; integrity: AuditIntegrity }>('GET', '/audit'),

  /** Solde et historique d'une adresse simulée, lus dans le ledger local. */
  readChain: (chain: Chain, address: string) => call<ChainData>('GET', `/chain/${chain}/${address}`),
} satisfies BankAuthority & Record<string, unknown>

/** Le client de la banque tel que l'application l'utilise (réel: `bankApi`; en test: un double). */
export type BankClient = typeof bankApi
