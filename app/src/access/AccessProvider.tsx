import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { bankApi, type BankClient, type PendingRequest } from '../bank/api'
import type { AuthorizeAction, BankPasskey } from '../bank/authority'
import { browserAuthenticator, type Authenticator } from '../bank/webauthn'
import { describeAgent } from '../provider/describe'
import type { AccessSnapshot, WalletProvider } from '../provider/types'
import { BankApiError, explain, type AccessError } from './errors'
import * as flows from './flows'
import { PasswordDialog } from './PasswordDialog'
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_PASSCODE } from './demo'

/* Accès de l'utilisateur à son wallet simulé, stocké dans ce navigateur. */

export type Backend = { wallet: WalletProvider; bank: BankClient; authenticator: Authenticator }

const POLL_MS = 15_000
const EMPTY: AccessSnapshot = { state: 'signed_out', accounts: [] }
/** Lien d'approbation d'appareil, gardé dans cet onglet jusqu'à ce qu'il ait servi: on peut ainsi le rouvrir après la connexion. */
const LINK_KEY = 'equinox.approvalLink'
/** Identifiants des passkeys créés sur CE navigateur: sans eux, l'app ne sait pas si l'appareil a déjà une clé. */
const HERE_KEY = 'equinox.passkeysHere'
export const REASON_PASSKEY = 'Confirm your local demo password to add a passkey on this device.'
export const REASON_SIGN = 'Confirm your local demo password to approve this transfer.'

/** Le client a fermé la fenêtre de mot de passe: ce n'est pas une erreur à afficher. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export function readPasskeysHere(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HERE_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function rememberPasskeyHere(id: string): string[] {
  const ids = [...new Set([...readPasskeysHere(), id])]
  try {
    localStorage.setItem(HERE_KEY, JSON.stringify(ids))
  } catch {
    /* navigation privée: on ne retient rien, ce n'est pas bloquant */
  }
  return ids
}

const isReauth = (e: unknown) => e instanceof BankApiError && e.code === 'reauth_required'

/** Refait `attempt` avec le mot de passe demandé au client, tant que la banque le réclame. Sans réclamation, rien ne s'affiche. */
async function withPassword<T>(attempt: (password?: string) => Promise<T>, ask: (error?: string) => Promise<string>): Promise<T> {
  let password: string | undefined
  let error: string | undefined
  for (;;) {
    try {
      return await attempt(password)
    } catch (e) {
      if (!isReauth(e)) throw e
      error = password === undefined ? undefined : e instanceof Error ? e.message : undefined
      password = await ask(error)
    }
  }
}

export type Access = {
  snapshot: AccessSnapshot
  /** Email du compte de banque connecté, ou null. */
  email: string | null
  busy: string | null
  step: string | null
  error: AccessError | null
  /** Passkeys enregistrés auprès de la banque (null tant qu'on ne les a pas lus). */
  passkeys: BankPasskey[] | null
  /** Identifiants des passkeys créés sur ce navigateur. */
  passkeyIdsHere: string[]
  /** Demandes d'ajout de passkey (récupération) qui attendent leur délai de sécurité (de cet appareil ou d'un autre). */
  pendingRequests: PendingRequest[]
  /** Le lien d'approbation reçu n'a pas fonctionné (expiré, déjà utilisé, ou ouvert dans un autre navigateur). */
  approvalFailed: boolean
  wallet: WalletProvider
  bank: BankClient
  authenticator: Authenticator
  signInDemo(): Promise<void>
  approveFromLink(url: string): Promise<void>
  /**
   * Ajoute un passkey sur cet appareil. `proof`: un passkey déjà enregistré confirme d'abord (appareil qui en a déjà un, sans délai).
   * Sans: récupération, avec le délai de sécurité de la banque; rend alors 'pending'.
   */
  addPasskey(o: { proof: boolean }): Promise<flows.PasskeyEnrollment | undefined>
  cancelRequest(id: string): Promise<void>
  /** Autorise une signature auprès de la banque (passkey, ou mot de passe si le compte n'en a pas). À appeler dans `act`. */
  authorize(o?: { action?: AuthorizeAction; authorizationId?: string }): Promise<'passkey' | 'password'>
  refreshPasskeys(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
  clearError(): void
  /** Exécute une action sensible avec les mêmes protections (une à la fois, repos après une panne). */
  act(label: string, fn: () => Promise<void>): Promise<boolean>
}

const Ctx = createContext<Access | null>(null)
export const useAccess = (): Access => {
  const a = useContext(Ctx)
  if (!a) throw new Error('useAccess must be used inside <AccessProvider>')
  return a
}

/** `backend` ne sert qu'aux tests (injection d'un fournisseur et d'une banque de test); l'application ne le passe jamais. */
export function AccessProvider({ children, backend: injected }: { children: ReactNode; backend?: Backend }) {
  const [backend, setBackend] = useState<Backend | null>(injected ?? null)
  const [snapshot, setSnapshot] = useState<AccessSnapshot>(EMPTY)
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<AccessError | null>(null)
  const [passkeys, setPasskeys] = useState<BankPasskey[] | null>(null)
  const [passkeyIdsHere, setPasskeyIdsHere] = useState<string[]>(() => readPasskeysHere())
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([])
  const [approvalFailed, setApprovalFailed] = useState(false)
  const [prompt, setPrompt] = useState<{ reason: string; error?: string } | null>(null)
  const busyRef = useRef(false)
  const started = useRef(false)
  const stateRef = useRef<AccessSnapshot['state']>(EMPTY.state)
  // La session de wallet n'est ouverte automatiquement qu'une fois par session de banque: pas de boucle d'essais.
  const autoConnect = useRef(false)
  // Un lien déjà essayé n'est pas réessayé en boucle dans cette page.
  const triedLink = useRef<string | null>(null)
  const promptRef = useRef<{ resolve: (pw: string) => void; reject: (e: Error) => void } | null>(null)

  useEffect(() => {
    if (injected) return
    loadBackend().then(setBackend, (e) => setError(explain(e)))
  }, [injected])

  /** Demande le mot de passe dans une fenêtre dédiée. Rejette avec CancelledError si le client la ferme. */
  const askPassword = useCallback(
    (reason: string) => (error?: string) => {
      if (email?.toLowerCase() === DEMO_EMAIL) return Promise.resolve(DEMO_PASSWORD)
      return new Promise<string>((resolve, reject) => {
        promptRef.current = { resolve, reject }
        setPrompt({ reason, error })
      })
    },
    [email],
  )
  const answerPrompt = useCallback((password: string | null) => {
    const p = promptRef.current
    promptRef.current = null
    setPrompt(null)
    if (!p) return
    if (password === null) p.reject(new CancelledError())
    else p.resolve(password)
  }, [])

  /** Relit l'état. Peut lever: l'appelant décide quoi faire de l'erreur (repos après un rate limit, etc.). */
  const refresh = useCallback(async () => {
    if (!backend) return
    const { wallet, bank } = backend
    const me = await bank.me()
    setEmail(me?.account.email ?? null)
    if (!me) {
      autoConnect.current = false
      if (wallet.isSignedIn()) await wallet.logout().catch(() => undefined)
      setSnapshot(EMPTY)
      setPendingRequests([])
      stateRef.current = EMPTY.state
      return
    }
    // La session de wallet doit appartenir au même client que la session de banque. Un email encore inconnu du fournisseur
    // n'est pas une différence: on ne ferme la session que sur une vraie différence.
    const walletEmail = wallet.currentEmail()
    if (wallet.isSignedIn() && walletEmail && walletEmail.toLowerCase() !== me.account.email) await wallet.logout().catch(() => undefined)
    if (!wallet.isSignedIn() && !autoConnect.current) {
      autoConnect.current = true
      await flows.connectWallet({ wallet, bank })
    }
    let next = await wallet.readAccess()
    if (me.account.email === DEMO_EMAIL && next.state === 'no_wallet') {
      await wallet.createWallets(DEMO_PASSCODE)
      next = await wallet.readAccess()
    } else if (me.account.email === DEMO_EMAIL && next.state === 'locked') {
      await wallet.unlock(DEMO_PASSCODE)
      next = await wallet.readAccess()
    }
    // Appareil en attente d'approbation: si un lien a été reçu dans cet onglet, on l'utilise tout de suite.
    if (next.state === 'device_approval') {
      const url = sessionStorage.getItem(LINK_KEY)
      if (url && triedLink.current !== url) {
        triedLink.current = url
        try {
          if (await wallet.completeDeviceApprovalFromUrl(url)) {
            sessionStorage.removeItem(LINK_KEY)
            setApprovalFailed(false)
            next = await wallet.readAccess()
          } else setApprovalFailed(true)
        } catch {
          setApprovalFailed(true) // lien expiré, déjà utilisé, ou ouvert ailleurs: on le dit, sans boucle
        }
      }
    }
    stateRef.current = next.state
    setSnapshot(next)
  }, [backend])

  const run = useCallback(
    async (label: string, fn: () => Promise<void>, during?: 'unlock'): Promise<boolean> => {
      if (!backend || busyRef.current) return false
      busyRef.current = true
      setBusy(label)
      setError(null)
      try {
        await fn()
        await refresh()
        return true
      } catch (e) {
        if (e instanceof CancelledError) return false
        const x = explain(e, during)
        setError(x)
        await refresh().catch(() => undefined)
        return false
      } finally {
        busyRef.current = false
        setBusy(null)
        setStep(null)
      }
    },
    [backend, refresh],
  )

  // Premier état. Si la page s'ouvre avec un lien d'approbation, on le garde dans cet onglet et on retire le jeton de la barre d'adresse.
  useEffect(() => {
    if (!backend || started.current) return
    started.current = true
    void run('Opening your session', async () => {
      await backend.wallet.ready() // une session existante doit être chargée avant de lire l'état
      const here = new URL(location.href)
      if (here.searchParams.has('deviceRegistrationToken')) {
        sessionStorage.setItem(LINK_KEY, location.href)
        here.searchParams.delete('deviceRegistrationToken')
        history.replaceState(null, '', here.pathname + here.search + here.hash)
      }
    })
  }, [backend, run])

  // Revenir sur la page (autre onglet, retour de l'application de messagerie) relit l'état pendant une approbation.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'visible' && stateRef.current === 'device_approval' && !busyRef.current) void refresh().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => {
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [refresh])

  // Passkeys de la banque: un simple appel de lecture sur NOTRE banque (aucun appel au fournisseur), une fois le wallet prêt.
  const loadPasskeys = useCallback(async () => {
    if (!backend) return
    setPasskeyIdsHere(readPasskeysHere()) // un autre onglet a pu en ajouter un
    try {
      setPasskeys(await backend.bank.passkeys())
    } catch {
      setPasskeys(null)
    }
  }, [backend])
  useEffect(() => {
    if (!backend || snapshot.state !== 'ready') return
    void loadPasskeys()
  }, [backend, snapshot.state, busy, loadPasskeys])

  // Demandes de passkey en attente: une lecture sur NOTRE banque (aucun appel au fournisseur), régulièrement.
  const loadPending = useCallback(async () => {
    if (!backend) return
    try {
      setPendingRequests(await backend.bank.pendingRequests())
    } catch {
      /* banque injoignable: on garde la dernière liste connue */
    }
  }, [backend])
  useEffect(() => {
    if (!backend || snapshot.state === 'signed_out') return
    void loadPending()
    const id = setInterval(() => void loadPending(), POLL_MS)
    return () => clearInterval(id)
  }, [backend, snapshot.state, loadPending])

  const value = useMemo<Access | null>(() => {
    if (!backend) return null
    const { wallet, bank, authenticator } = backend
    const deps = { wallet, bank, authenticator }
    const holder = <T,>() => ({ value: undefined as T | undefined })
    const label = () => describeAgent(typeof navigator === 'undefined' ? '' : navigator.userAgent)
    const remember = (r?: flows.PasskeyEnrollment) => {
      if (r?.status === 'registered' && r.passkey) setPasskeyIdsHere(rememberPasskeyHere(r.passkey.id))
    }
    return {
      snapshot,
      email,
      busy,
      step,
      error,
      passkeys,
      passkeyIdsHere,
      pendingRequests,
      approvalFailed,
      wallet,
      bank,
      authenticator,
      async signInDemo() {
        autoConnect.current = true // la connexion du wallet fait partie de cette action
        const ok = await run('Signing in', async () => {
          try {
            await bank.register(DEMO_EMAIL, DEMO_PASSWORD)
          } catch (e) {
            if (!(e instanceof BankApiError) || e.code !== 'email_taken') throw e
            await bank.login(DEMO_EMAIL, DEMO_PASSWORD)
          }
          await flows.connectWallet(deps)
        })
        if (!ok) autoConnect.current = false
      },
      async approveFromLink(url) {
        await run('Approving this device', async () => {
          if (!(await wallet.completeDeviceApprovalFromUrl(url))) {
            throw new Error('This is not a device approval link. Copy the whole link from the email and try again.')
          }
          sessionStorage.removeItem(LINK_KEY)
          setApprovalFailed(false)
        })
      },
      async addPasskey({ proof }) {
        const out = holder<flows.PasskeyEnrollment>()
        await run(proof ? 'Confirming with your passkey' : 'Adding a passkey', async () => {
          out.value = await withPassword(
            (password) => flows.addPasskey(deps, { label: label(), password, proof, onStep: (s) => setStep(s) }),
            askPassword(REASON_PASSKEY),
          )
        })
        remember(out.value)
        await Promise.all([loadPending(), loadPasskeys()])
        return out.value
      },
      async cancelRequest(id) {
        if (await run('Cancelling the request', async () => void (await bank.cancelRequest(id)))) await loadPending()
      },
      authorize: (o) => withPassword((password) => flows.authorizeSigning(deps, { ...o, password }), askPassword(REASON_SIGN)),
      async signOut() {
        await run('Signing out', async () => {
          // Les deux sessions se ferment: si l'une échoue, l'autre doit quand même être fermée.
          await Promise.allSettled([bank.logout(), wallet.logout()])
        })
        sessionStorage.removeItem(LINK_KEY)
        triedLink.current = null
        setApprovalFailed(false)
        setPasskeys(null)
        setPendingRequests([])
      },
      refresh: async () => {
        try {
          await refresh()
        } catch (e) {
          setError(explain(e))
        }
      },
      refreshPasskeys: loadPasskeys,
      clearError: () => setError(null),
      act: (label, fn) => run(label, fn),
    }
  }, [backend, snapshot, email, busy, step, error, passkeys, passkeyIdsHere, pendingRequests, approvalFailed, run, refresh, loadPending, loadPasskeys, askPassword])

  if (!value) {
    return <div className="boot" role="status">{error ? error.message : 'Loading…'}</div>
  }
  return (
    <Ctx.Provider value={value}>
      {children}
      {prompt && (
        <PasswordDialog
          reason={prompt.reason}
          error={prompt.error}
          onConfirm={(password) => answerPrompt(password)}
          onCancel={() => answerPrompt(null)}
        />
      )}
    </Ctx.Provider>
  )
}

async function loadBackend(): Promise<Backend> {
  const { localProvider } = await import('../provider/local')
  return { wallet: localProvider, bank: bankApi, authenticator: browserAuthenticator }
}
