import type { AccessSnapshot, Chain, DeviceInfo, WalletAccount, WalletProvider } from './types'

type LocalUser = {
  accountId: string
  wallets: WalletAccount[]
  passcodeHash?: string
}

type LocalStore = {
  accountId?: string
  email?: string
  users: Record<string, LocalUser>
}

const STORE_KEY = 'equinox.localWallet.v1'
const unlockedKey = (email: string) => `equinox.localWallet.unlocked.${email}`
const ADDRESSES: Record<Chain, string> = {
  BTC: 'tb1q9rp4v3rlw47zyzargsfmx6edtrg030adng3rh4',
  EVM: '0x6DB8A8CDE4fF95d95570589D850136D2B0932b1D',
  SOL: 'EWdbpPpotPtJrvBms5j4cVQouo7iR5DVvJjCVL99pAWX',
}
const HEX = '0123456789abcdef'

function store(): LocalStore {
  const raw = localStorage.getItem(STORE_KEY)
  if (!raw) return { users: {} }
  try {
    const value = JSON.parse(raw) as LocalStore
    if (!value || typeof value !== 'object' || !value.users || typeof value.users !== 'object') throw new Error()
    return value
  } catch {
    throw new Error('Local wallet data is unreadable. Clear this site’s storage to start over.')
  }
}

function save(value: LocalStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(value))
}

function payload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) throw new Error('The local bank returned an invalid token.')
  try {
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
  } catch {
    throw new Error('The local bank returned an invalid token.')
  }
}

async function passcodeHash(email: string, passcode: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${email}\0${passcode}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return [...bytes].map((b) => HEX[b & 15]).join('')
}

function userOrThrow(data: LocalStore): { email: string; user: LocalUser } {
  if (!data.email) throw new Error('Sign in to the local bank first.')
  const user = data.users[data.email]
  if (!user) throw new Error('No local wallet exists for this account.')
  return { email: data.email, user }
}

function takeGrant(scope: string): Record<string, unknown> {
  const grants = JSON.parse(sessionStorage.getItem('equinox.localWallet.grants') ?? '[]') as string[]
  const index = grants.indexOf(scope)
  if (index < 0) throw new Error('The local bank has not authorized this action.')
  grants.splice(index, 1)
  sessionStorage.setItem('equinox.localWallet.grants', JSON.stringify(grants))
  return {}
}

export const localProvider: WalletProvider = {
  name: 'local simulation',
  ready: async () => {},
  isSignedIn: () => Boolean(store().email),
  currentEmail: () => store().email,

  async readAccess(): Promise<AccessSnapshot> {
    const data = store()
    if (!data.email) return { state: 'signed_out', accounts: [] }
    const user = data.users[data.email]
    if (!user?.wallets.length) return { state: 'no_wallet', email: data.email, accounts: [] }
    const unlocked = sessionStorage.getItem(unlockedKey(data.email)) === 'true'
    return { state: unlocked ? 'ready' : 'locked', email: data.email, accounts: user.wallets }
  },

  async signInWithSso(jwt) {
    const claims = payload(jwt)
    if (typeof claims.email !== 'string' || typeof claims.sub !== 'string' || !claims.sub.startsWith('sq-')) {
      throw new Error('The local bank returned an invalid sign-in token.')
    }
    const data = store()
    const email = claims.email.toLowerCase()
    data.users[email] ??= { accountId: claims.sub, wallets: [] }
    data.users[email].accountId = claims.sub
    data.email = email
    data.accountId = claims.sub
    save(data)
  },

  async logout() {
    const data = store()
    if (data.email) sessionStorage.removeItem(unlockedKey(data.email))
    data.email = undefined
    data.accountId = undefined
    save(data)
    sessionStorage.removeItem('equinox.localWallet.grants')
  },

  async completeDeviceApprovalFromUrl() {
    return false
  },

  async createWallets(passcode) {
    const data = store()
    const { email, user } = userOrThrow(data)
    if (user.wallets.length) throw new Error('Local simulated wallets already exist for this account.')
    user.wallets = (['BTC', 'EVM', 'SOL'] as const).map((chain) => ({
      chain,
      address: chain === 'EVM' ? `0x${randomHex(40)}` : ADDRESSES[chain],
    }))
    user.passcodeHash = await passcodeHash(email, passcode)
    save(data)
    sessionStorage.setItem(unlockedKey(email), 'true')
  },

  listAccounts() {
    const data = store()
    return data.email ? data.users[data.email]?.wallets ?? [] : []
  },

  async unlock(passcode) {
    const data = store()
    const { email, user } = userOrThrow(data)
    if (!user.passcodeHash || (await passcodeHash(email, passcode)) !== user.passcodeHash) {
      throw new Error('Incorrect password')
    }
    sessionStorage.setItem(unlockedKey(email), 'true')
  },

  async stepUpWithSso(assertionJwt) {
    const claims = payload(assertionJwt)
    const data = store()
    if (typeof claims.sub !== 'string' || claims.sub !== data.accountId) throw new Error('The local bank authorization belongs to another account.')
    if (claims.scope !== 'wallet:sign' && claims.scope !== 'wallet:export') throw new Error('The local bank authorization has an invalid scope.')
    const grants = JSON.parse(sessionStorage.getItem('equinox.localWallet.grants') ?? '[]') as string[]
    grants.push(claims.scope)
    sessionStorage.setItem('equinox.localWallet.grants', JSON.stringify(grants))
  },

  async listDevices(): Promise<DeviceInfo[]> {
    return [{ id: 'local-browser', current: true, label: 'This browser', createdAt: new Date(0).toISOString() }]
  },
  async revokeDevice() {},
  async revokeAllDevices() {},

  async signOwnershipProof(chain, message) {
    const { email, user } = userOrThrow(store())
    const account = user.wallets.find((wallet) => wallet.chain === chain)
    if (!account) throw new Error(`No ${chain} simulated wallet exists.`)
    takeGrant('wallet:sign')
    return { address: account.address, signature: `SIMULATED-${await passcodeHash(email, `${chain}:${message}`)}` }
  },

  async sendNative(chain, to, amount) {
    const { user } = userOrThrow(store())
    if (!user.wallets.some((wallet) => wallet.chain === chain)) throw new Error(`No ${chain} simulated wallet exists.`)
    takeGrant('wallet:sign')
    const hash = `local-${randomHex(32)}`
    void to
    void amount
    return { hash }
  },

  async exportPrivateKey(chain, passcode, container) {
    const data = store()
    const { email, user } = userOrThrow(data)
    if (!user.wallets.some((wallet) => wallet.chain === chain)) throw new Error(`No ${chain} simulated wallet exists.`)
    if (!user.passcodeHash || (await passcodeHash(email, passcode)) !== user.passcodeHash) throw new Error('Incorrect password')
    takeGrant('wallet:export')
    container.textContent = 'Offline simulation only. This wallet has no private key.'
  },
}
