import type { AccessSnapshot, Chain, DeviceInfo, WalletAccount, WalletProvider } from '../provider/types'

/*
 * DOUBLE DE TEST du fournisseur de wallet. Il n'est utilisé que par les tests unitaires: l'application, elle, parle toujours au
 * vrai fournisseur. Il reproduit les comportements observés pendant le prototype:
 * - appareil inconnu => il faut ouvrir un lien reçu par email;
 * - SIGNER ou EXPORTER une clé exige un jeton remis par la banque (portée wallet:sign / wallet:export), à usage unique ici:
 *   sans lui le fournisseur répond « Elevated access token required » (403), même à un client sans aucun passkey;
 * - le fournisseur ne connaît AUCUN passkey: ils sont ceux de la banque. Un compte qui en détient encore un chez lui
 *   (ancienne version du produit) reste bloqué sur un second facteur que personne ne peut fournir;
 * - sans accès complet, créer ou déverrouiller un wallet est refusé.
 *
 * Il permet de tester tous les parcours sans aucun fournisseur externe.
 * Un "monde" regroupe un serveur partagé et plusieurs appareils.
 */

export type Scenario = {
  /** Comptes qui détiennent encore un passkey chez le fournisseur (ancienne version): leur session reste en attente de ce second facteur. */
  legacyPasskeyUsers: string[]
}

export interface KV {
  get(key: string): string | null
  set(key: string, value: string): void
}

export function memoryKv(): KV {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) }
}

type DeviceRec = { id: string; label: string; createdAt: string }
type UserRec = { devices: DeviceRec[]; wallets: WalletAccount[]; passcode?: string }
type Mail = { to: string; link: string }
type World = { users: Record<string, UserRec>; approvals: Record<string, string>; mail: Mail[]; seq: number }
type DeviceState = {
  email?: string
  pendingApproval: boolean
  /** jetons remis par la banque, pas encore consommés (une signature en consomme un) */
  elevated: string[]
  /** emails dont la part de clé est déjà présente sur cet appareil */
  hasShare: string[]
}

const WORLD_KEY = 'world'
let sends = 0
const emptyWorld = (): World => ({ users: {}, approvals: {}, mail: [], seq: 1 })
const emptyDevice = (): DeviceState => ({ pendingApproval: false, elevated: [], hasShare: [] })

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
function stream(seed: string, n: number, alphabet: string): string {
  let out = ''
  let h = hash(seed)
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    h = (h + 0x9e3779b9) >>> 0
    out += alphabet[h % alphabet.length]
  }
  return out
}
const HEX = '0123456789abcdef'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const walletsFor = (email: string): WalletAccount[] => [
  { chain: 'EVM', address: '0x' + stream(email + 'evm', 40, HEX) },
  { chain: 'SOL', address: stream(email + 'sol', 44, B58) },
  { chain: 'BTC', address: 'tb1q' + stream(email + 'btc', 38, BECH) },
]

function decode(jwt: string): { email: string; scope?: string } {
  if (!jwt.startsWith('fake.')) throw new Error('Invalid token')
  return JSON.parse(atob(jwt.slice(5)))
}

/** Jeton de test lisible par le double (le vrai fournisseur, lui, vérifie une signature RS256). */
export const fakeToken = (claims: { email: string; scope?: string }) => `fake.${btoa(JSON.stringify(claims))}`

export interface FakeWorld {
  scenario: Scenario
  device(id: string, label?: string): WalletProvider
  /** Emails d'approbation d'appareil "envoyés" (le dernier est le plus récent). */
  mailbox(): Mail[]
}

export function createFakeWorld(opts: { scenario?: Partial<Scenario>; kv?: KV } = {}): FakeWorld {
  const scenario: Scenario = { legacyPasskeyUsers: [], ...opts.scenario }
  const kv = opts.kv ?? memoryKv()
  const linkBase = 'http://localhost:5173/'

  const loadWorld = (): World => {
    const raw = kv.get(WORLD_KEY)
    return raw ? (JSON.parse(raw) as World) : emptyWorld()
  }
  const saveWorld = (w: World) => kv.set(WORLD_KEY, JSON.stringify(w))
  const user = (w: World, email: string): UserRec => (w.users[email] ??= { devices: [], wallets: [] })

  function device(id: string, label = `Browser ${id}`): WalletProvider {
    const dKey = `device.${id}`
    const loadDev = (): DeviceState => {
      const raw = kv.get(dKey)
      return raw ? (JSON.parse(raw) as DeviceState) : emptyDevice()
    }
    const saveDev = (d: DeviceState) => kv.set(dKey, JSON.stringify(d))
    /** Charge monde + appareil + utilisateur connecté, ou échoue. */
    function session() {
      const w = loadWorld()
      const d = loadDev()
      if (!d.email) throw new Error('Unauthorized')
      return { w, d, u: user(w, d.email), email: d.email }
    }
    const stuckOnLegacyPasskey = (email: string) => scenario.legacyPasskeyUsers.includes(email)
    const blocked = () =>
      new Error(
        'Cannot create or access the embedded wallet until onboarding is complete (pending MFA, KYC, recovery-codes acknowledgment, or device registration).',
      )
    /** Accès complet exigé pour toucher aux wallets: appareil approuvé et second facteur satisfait. */
    function guarded() {
      const s = session()
      if (s.d.pendingApproval || stuckOnLegacyPasskey(s.email)) throw blocked()
      return s
    }

    /** Consomme un jeton de la banque pour cette action, ou refuse comme le fait le vrai fournisseur. */
    function consume(scope: string) {
      const d = loadDev()
      const i = d.elevated.indexOf(scope)
      if (i < 0) throw new Error('Elevated access token required')
      d.elevated.splice(i, 1)
      saveDev(d)
    }

    function startSession(email: string) {
      const w = loadWorld()
      const d = loadDev()
      const u = user(w, email)
      d.email = email
      d.elevated = []
      d.pendingApproval = false
      if (u.devices.length === 0) {
        u.devices.push({ id, label, createdAt: new Date().toISOString() }) // premier appareil: enregistré d'office
      } else if (!u.devices.some((x) => x.id === id)) {
        d.pendingApproval = true
        const token = `fake-${w.seq++}-${stream(email + id + w.seq, 12, HEX)}`
        w.approvals[token] = email
        w.mail.push({ to: email, link: `${linkBase}?deviceRegistrationToken=${token}` })
      }
      saveWorld(w)
      saveDev(d)
    }

    return {
      name: 'fake',
      ready: async () => {},
      isSignedIn: () => !!loadDev().email,
      currentEmail: () => loadDev().email,

      async readAccess(): Promise<AccessSnapshot> {
        const d = loadDev()
        if (!d.email) return { state: 'signed_out', accounts: [] }
        const u = user(loadWorld(), d.email)
        const base = { email: d.email, accounts: u.wallets }
        if (d.pendingApproval) return { state: 'device_approval', ...base }
        if (stuckOnLegacyPasskey(d.email)) return { state: 'mfa_required', ...base }
        if (u.wallets.length === 0) return { state: 'no_wallet', ...base }
        return { state: d.hasShare.includes(d.email) ? 'ready' : 'locked', ...base }
      },

      async signInWithSso(jwt) {
        startSession(decode(jwt).email)
      },
      async logout() {
        const d = loadDev()
        saveDev({ ...emptyDevice(), hasShare: d.hasShare })
      },
      async completeDeviceApprovalFromUrl(url) {
        const token = new URL(url).searchParams.get('deviceRegistrationToken')
        if (!token) return false
        const w = loadWorld()
        const d = loadDev()
        const email = w.approvals[token]
        if (!email || email !== d.email) throw new Error('Invalid or expired device registration token')
        user(w, email).devices.push({ id, label, createdAt: new Date().toISOString() })
        delete w.approvals[token]
        d.pendingApproval = false
        saveWorld(w)
        saveDev(d)
        return true
      },

      async createWallets(passcode) {
        const { w, d, u, email } = guarded()
        const have = new Set(u.wallets.map((a) => a.chain))
        u.wallets.push(...walletsFor(email).filter((a) => !have.has(a.chain)))
        u.passcode ??= passcode
        if (!d.hasShare.includes(email)) d.hasShare.push(email)
        saveWorld(w)
        saveDev(d)
      },
      listAccounts() {
        const d = loadDev()
        return d.email ? user(loadWorld(), d.email).wallets : []
      },
      async unlock(passcode) {
        const { d, u, email } = guarded()
        if (passcode !== u.passcode) throw new Error('Incorrect password')
        if (!d.hasShare.includes(email)) d.hasShare.push(email)
        saveDev(d)
      },

      async stepUpWithSso(assertionJwt) {
        const { d, email } = session()
        const a = decode(assertionJwt)
        if (a.email !== email) throw new Error('Assertion JWT subject does not match the authenticated user')
        // Comme chez le vrai fournisseur: sans session complète (appareil à approuver, second facteur en attente), la requête est refusée.
        if (d.pendingApproval || stuckOnLegacyPasskey(email)) throw new Error('Unauthorized')
        d.elevated.push(a.scope ?? '')
        saveDev(d)
      },

      async listDevices(): Promise<DeviceInfo[]> {
        const { u } = session()
        return u.devices.map((x) => ({ id: x.id, current: x.id === id, label: x.label, createdAt: x.createdAt }))
      },
      async revokeDevice(deviceId) {
        const { w, u } = session()
        u.devices = u.devices.filter((x) => x.id !== deviceId)
        saveWorld(w)
      },
      async revokeAllDevices() {
        const { w, u } = session()
        u.devices = u.devices.filter((x) => x.id === id)
        saveWorld(w)
      },

      async signOwnershipProof(chain: Chain, message: string) {
        const { u, d, email } = guarded()
        if (!d.hasShare.includes(email)) throw blocked()
        const account = u.wallets.find((a) => a.chain === chain)
        if (!account) throw new Error(`No ${chain} wallet`)
        consume('wallet:sign')
        return { address: account.address, signature: stream(message + account.address, 88, B58) }
      },

      async sendNative(chain: Chain, to: string, amount: string) {
        const { u, d, email } = guarded()
        if (!d.hasShare.includes(email)) throw blocked() // la part du client doit être déchiffrée
        if (!u.wallets.some((a) => a.chain === chain)) throw new Error(`No ${chain} wallet`)
        consume('wallet:sign')
        return { hash: '0x' + stream(`${chain}${to}${amount}${sends++}`, 64, HEX) }
      },

      async exportPrivateKey(chain: Chain, passcode: string, container: HTMLElement) {
        const { u, d, email } = guarded()
        if (!u.wallets.some((a) => a.chain === chain)) throw new Error(`No ${chain} wallet`)
        if (passcode !== u.passcode) throw new Error('Incorrect password')
        if (!d.hasShare.includes(email)) throw blocked()
        consume('wallet:export')
        container.textContent = `FAKE PRIVATE KEY for ${chain}: ${stream(email + chain + 'key', 64, HEX)}`
      },
    }
  }

  return {
    scenario,
    device,
    mailbox: () => loadWorld().mail,
  }
}
