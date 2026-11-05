// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'
import { DEMO_EMAIL } from './access/demo'
import { connectWallet, setupWallet } from './access/flows'
import { fakeAuthenticator } from './testing/fakeAuthenticator'
import { fakeBankClient } from './testing/fakeBankClient'
import { createFakeWorld, memoryKv, type Scenario } from './testing/fakeWallet'
import type { ChainTx } from './bank/api'
import type { EnrollStart } from './bank/authority'

/* Les vrais écrans de l'application, avec un fournisseur et une banque de test injectés.
   Ils vérifient que chaque écran se rend, que les formulaires font ce qu'ils disent et que les appels à la banque
   et au fournisseur sont les bons. Le comportement réel du fournisseur est vérifié séparément, en navigateur. */

const EMAIL = 'client@example.ch'
const RECIPIENT_BTC = 'tb1q9rp4v3rlw47zyzargsfmx6edtrg030adng3rh4'

beforeEach(() => {
  localStorage.clear() // les passkeys « créés sur cet appareil » sont retenus dans le navigateur: on repart de zéro à chaque test
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const tx = (over: Partial<ChainTx>): ChainTx => ({ hash: 'abc', time: 1_791_000_000_000, confirmed: true, ok: true, direction: 'in', amount: 0.001, fee: null, counterparty: RECIPIENT_BTC, ...over })

/** Un client déjà connecté, avec son wallet créé et son premier passkey (celui de la banque): l'application s'ouvre sur la vue d'ensemble. */
async function ready(opts: { delayMs?: number; passkey?: boolean; passwordFor?: string } = {}) {
  const world = createFakeWorld({ kv: memoryKv() })
  const wallet = world.device('A', 'Chrome on Linux')
  const bank = fakeBankClient({ email: EMAIL, signedIn: true, delayMs: opts.delayMs, passwordFor: opts.passwordFor })
  const authenticator = fakeAuthenticator('A')
  const spy = vi.spyOn(wallet, 'sendNative')
  await connectWallet({ wallet, bank })
  // `passkey: false`: le client a créé ses wallets mais refusé l'invite du passkey (compte pas encore équipé).
  if (opts.passkey === false) authenticator.refuseNext()
  await setupWallet({ wallet, bank, authenticator }, 'passcode-123', { label: 'Chrome on Linux', password: opts.passwordFor }).catch((e) => {
    if (opts.passkey !== false) throw e
  })
  const btc = wallet.listAccounts().find((a) => a.chain === 'BTC')!.address
  bank.state.chain.BTC = { balance: 0.0025, txs: [tx({ hash: 'in1', amount: 0.003 }), tx({ hash: 'out1', direction: 'out', amount: 0.0005, fee: 0.00001, time: 1_791_100_000_000 })] }
  bank.state.chain.EVM = { balance: 0.5, txs: [] }
  bank.state.chain.SOL = { balance: 3, txs: [tx({ hash: 'sol1', amount: 3, time: 1_791_200_000_000, unknown: false } as Partial<ChainTx>)] }
  const user = userEvent.setup()
  render(<App backend={{ wallet, bank, authenticator }} />)
  await screen.findByRole('heading', { name: 'Your wallets' })
  return { wallet, bank, user, btc, sendSpy: spy, authenticator }
}

const nav = (name: RegExp) => screen.getByRole('button', { name })

describe('vue d\'ensemble', () => {
  it('montre les trois wallets avec leurs vrais soldes, et l\'activité récente', async () => {
    await ready()
    expect(await screen.findByText('0.0025')).toBeTruthy() // solde Bitcoin lu par la banque
    expect(screen.getByText('0.5')).toBeTruthy()
    expect(screen.getByText('Bitcoin testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    const latest = screen.getByRole('heading', { name: 'Latest activity' }).closest('.panel') as HTMLElement
    expect(within(latest).getAllByText(/Received|Sent/).length).toBeGreaterThan(0)
  })

  it("conseille un second passkey quand il n'y en a qu'un", async () => {
    await ready()
    expect(await screen.findByText(/You have a single passkey/)).toBeTruthy()
  })
})

describe('envoi', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, to: string, amount: string) {
    await user.click(nav(/Send and receive/))
    const recipient = (await screen.findByLabelText('Recipient address (required)')) as HTMLInputElement
    expect(recipient.disabled).toBe(true)
    expect(recipient.value).toBe(to)
    await user.type(screen.getByLabelText(/Amount in BTC/), amount)
  }

  it('keeps the recipient fixed and prevents editing it', async () => {
    const { user } = await ready()
    await user.click(nav(/Send and receive/))
    const recipient = (await screen.findByLabelText('Recipient address (required)')) as HTMLInputElement
    expect(recipient.disabled).toBe(true)
    expect(recipient.value).toBe(RECIPIENT_BTC)
    expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull()
    await user.type(recipient, 'not-an-address')
    expect(recipient.value).toBe(RECIPIENT_BTC)
  })

  it('contrôle de la banque, confirmation par passkey, signature, compte rendu à la banque', async () => {
    const { user, bank, sendSpy } = await ready()
    await fill(user, RECIPIENT_BTC, '0.001')
    await user.click(screen.getByRole('button', { name: 'Ask the bank to check this transfer' }))
    expect(bank.state.checks).toEqual([{ chain: 'BTC', to: RECIPIENT_BTC, amount: 0.001 }])
    await user.click(await screen.findByRole('button', { name: /Confirm with passkey and send/ }))
    await screen.findByRole('heading', { name: 'Transfer simulated' })
    expect(sendSpy).toHaveBeenCalledWith('BTC', RECIPIENT_BTC, '0.001')
    // La banque a autorisé CETTE signature auprès du fournisseur, après le passkey du client, liée à la décision qu'elle venait de rendre.
    expect(bank.rules.signed).toEqual([{ method: 'passkey', authorizationId: 'auth-1' }])
    expect(bank.state.audit.some((e) => e.action === 'signing.authorized')).toBe(true)
    expect(bank.state.reports).toHaveLength(1)
    expect(bank.state.reports[0].authorizationId).toBe('auth-1')
    expect(bank.state.reports[0].hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(await screen.findByRole('heading', { name: 'Transfer simulated' })).toBeTruthy()
  })

  it('un montant au-dessus du plafond est refusé avec le motif, même si le solde le permet', async () => {
    const { user, bank, sendSpy } = await ready()
    bank.state.policy.maxPerTx.BTC = 0.001 // le solde (0.0025) couvre 0.002, mais pas le plafond que le client s'est fixé
    await fill(user, RECIPIENT_BTC, '0.002')
    await user.click(screen.getByRole('button', { name: 'Ask the bank to check this transfer' }))
    expect(await screen.findByText('The bank refuses this transfer')).toBeTruthy()
    expect(screen.getAllByText(/Limit per transfer exceeded \(0\.002 > 0\.001 BTC\)/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Confirm with passkey/ })).toBeNull()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it("n'autorise pas à demander à la banque quand le solde ne couvre pas le montant et les frais", async () => {
    const { user } = await ready()
    await fill(user, RECIPIENT_BTC, '0.0025') // tout le solde, sans marge pour les frais
    expect((screen.getByRole('button', { name: 'Ask the bank to check this transfer' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Amount plus estimated fee is more than your balance')).toBeTruthy()
  })

  it("sans passkey, la banque redemande le mot de passe dans une fenêtre dédiée, puis la signature est autorisée", async () => {
    const { user, bank, sendSpy } = await ready({ passkey: false, passwordFor: 'bank password' })
    expect(bank.rules.enrolled).toHaveLength(0)
    await fill(user, RECIPIENT_BTC, '0.001')
    await user.click(screen.getByRole('button', { name: 'Ask the bank to check this transfer' }))
    await user.click(await screen.findByRole('button', { name: /Confirm with passkey and send/ }))
    const field = await screen.findByLabelText(/Local demo password/)
    expect(sendSpy).not.toHaveBeenCalled()
    await user.type(field, 'bank password')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByRole('heading', { name: 'Transfer simulated' })
    expect(bank.rules.signed).toEqual([{ method: 'password', authorizationId: 'auth-1' }])
  })

  it("un passkey refusé à la confirmation n'engage rien: rien n'est signé, la décision de la banque reste valable, on réessaie", async () => {
    const { user, bank, sendSpy, authenticator } = await ready()
    await fill(user, RECIPIENT_BTC, '0.001')
    await user.click(screen.getByRole('button', { name: 'Ask the bank to check this transfer' }))
    authenticator.refuseNext()
    await user.click(await screen.findByRole('button', { name: /Confirm with passkey and send/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(bank.state.reports).toHaveLength(0) // pas un échec de transfert: le client a simplement renoncé
    expect(bank.rules.signed).toHaveLength(0)
    await user.click(await screen.findByRole('button', { name: /Confirm with passkey and send/ }))
    await screen.findByRole('heading', { name: 'Transfer simulated' })
    expect(bank.rules.signed).toEqual([{ method: 'passkey', authorizationId: 'auth-1' }])
  })

  it('une signature qui échoue est rapportée à la banque et affichée, sans faux succès', async () => {
    const { user, bank, sendSpy } = await ready()
    sendSpy.mockRejectedValueOnce(new Error('The network refused the transaction'))
    await fill(user, RECIPIENT_BTC, '0.001')
    await user.click(screen.getByRole('button', { name: 'Ask the bank to check this transfer' }))
    await user.click(await screen.findByRole('button', { name: /Confirm with passkey and send/ }))
    await waitFor(() => expect(bank.state.reports).toHaveLength(1))
    expect(bank.state.reports[0].hash).toBeUndefined()
    expect(bank.state.reports[0].error).toMatch(/network refused/)
    expect(screen.queryByRole('heading', { name: 'Transfer simulated' })).toBeNull()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('historique', () => {
  it('réunit les transactions des trois réseaux et se filtre', async () => {
    const { user } = await ready()
    await user.click(nav(/Transaction history/))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row').length).toBe(1 + 3) // en-tête + 3 transactions
    await user.click(screen.getByRole('button', { name: 'Sent' }))
    expect(within(table).getAllByRole('row').length).toBe(1 + 1)
    await user.click(screen.getByRole('button', { name: 'Solana' }))
    expect(screen.getByText(/No entries match/)).toBeTruthy()
  })
})

describe('sécurité', () => {
  async function security(opts: { delayMs?: number } = {}) {
    const r = await ready(opts)
    await r.user.click(screen.getByRole('button', { name: /Open profile and settings/ }))
    await r.user.click(await screen.findByRole('tab', { name: /Security/ }))
    await screen.findByRole('heading', { name: 'Passkeys' })
    return r
  }

  it("la liste montre les passkeys de la banque, avec leur nature; un seul passkey: conseil d'en ajouter un", async () => {
    const { bank } = await security()
    expect(await screen.findByText(/on this device only/)).toBeTruthy()
    expect(screen.getAllByText(/Chrome on Linux/).length).toBeGreaterThan(0)
    expect(screen.getByText(/You have a single passkey/)).toBeTruthy()
    expect(bank.rules.enrolled).toHaveLength(1)
  })

  it("ajouter un passkey sur un appareil qui n'en a pas: la banque impose son délai de sécurité, annulable", async () => {
    const { user, bank } = await security({ delayMs: 60_000 })
    bank.rules.expireStrong() // le temps a passé depuis le dernier passkey vérifié
    await user.click(screen.getByRole('button', { name: 'Add a passkey to this device' }))
    expect(await screen.findByText(/A new passkey is waiting/)).toBeTruthy()
    expect(bank.rules.pendingRequests()).toHaveLength(1)
    await user.click(screen.getAllByRole('button', { name: /Cancel it/ })[0])
    await waitFor(() => expect(bank.rules.pendingRequests()).toHaveLength(0))
    await waitFor(() => expect(screen.queryByText(/waiting for its security delay/)).toBeNull())
    expect(bank.rules.enrolled).toHaveLength(1)
  })

  it("retirer un passkey demande un passkey à l'instant; le dernier ne peut pas être retiré", async () => {
    const { user, bank, authenticator } = await ready()
    const start = (await bank.registerOptions()) as Extract<EnrollStart, { status: 'ready' }>
    await bank.registerVerify({ challengeId: start.challengeId, credential: { id: 'cred-phone', challenge: start.publicKey.challenge }, label: 'Phone' })
    // Le premier passkey a été créé sur CET appareil: il est donc retiré le navigateur comme « sur cet appareil ».
    const [here] = await bank.passkeys()
    localStorage.setItem('equinox.passkeysHere', JSON.stringify([here.id]))
    await user.click(screen.getByRole('button', { name: /Open profile and settings/ }))
    await user.click(await screen.findByRole('tab', { name: /Security/ }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)) // la liste se relit à l'ouverture de la page
    const remove = screen.getAllByRole('button', { name: 'Remove' })
    bank.rules.expireStrong() // le temps a passé: la banque exige un passkey pour retirer
    const prompts = authenticator.prompts
    await user.click(remove[1])
    await waitFor(() => expect(bank.rules.enrolled).toHaveLength(1))
    expect(authenticator.prompts).toBe(prompts + 1)
    expect(bank.rules.enrolled[0].label).not.toBe('Phone')
    expect((await screen.findByRole('button', { name: 'Remove' })) as HTMLButtonElement).toHaveProperty('disabled', true)
  })
})

describe('offline simulation', () => {
  async function wallets() {
    const r = await ready()
    await r.user.click(screen.getByRole('button', { name: /Open profile and settings/ }))
    await screen.findByRole('heading', { name: 'Offline simulation' })
    return r
  }

  it('states that wallet data is simulated and does not offer fake key export or signatures', async () => {
    await wallets()
    expect(screen.getByText(/does not create private keys, sign transactions, or connect to a blockchain/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show the private key/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Prove ownership/ })).toBeNull()
  })
})

describe('règles de la banque et audit', () => {
  it('charge la politique du serveur, l\'enregistre côté serveur, affiche un audit vérifié', async () => {
    const { user, bank } = await ready()
    await user.click(screen.getByRole('button', { name: /Open profile and settings/ }))
    await user.click(await screen.findByRole('tab', { name: /Bank rules and audit/ }))
    const limit = (await screen.findByLabelText('Per transfer, BTC')) as HTMLInputElement
    expect(limit.value).toBe('0.01')
    await user.clear(limit)
    await user.type(limit, '0.5')
    await user.click(screen.getByRole('button', { name: 'Save rules' }))
    await waitFor(() => expect(bank.state.policy.maxPerTx.BTC).toBe(0.5))
    expect(await screen.findByText(/Chain verified/)).toBeTruthy()
    expect(screen.getAllByText('Limits updated').length).toBeGreaterThan(0)
  })

  it('une limite invalide bloque l\'enregistrement', async () => {
    const { user, bank } = await ready()
    await user.click(screen.getByRole('button', { name: /Open profile and settings/ }))
    await user.click(await screen.findByRole('tab', { name: /Bank rules and audit/ }))
    const limit = (await screen.findByLabelText('Per transfer, BTC')) as HTMLInputElement
    await user.clear(limit)
    await user.type(limit, 'beaucoup')
    expect((screen.getByRole('button', { name: 'Save rules' }) as HTMLButtonElement).disabled).toBe(true)
    expect(bank.state.audit.some((e) => e.action === 'rules.updated')).toBe(false)
  })
})

describe('connexion à la banque', () => {
  async function signedOut(scenario?: Partial<Scenario>) {
    const world = createFakeWorld({ kv: memoryKv(), scenario })
    const wallet = world.device('A', 'Chrome on Linux')
    const bank = fakeBankClient({ email: DEMO_EMAIL })
    const authenticator = fakeAuthenticator('A')
    const user = userEvent.setup()
    render(<App backend={{ wallet, bank, authenticator }} />)
    await screen.findByRole('heading', { name: scenario?.legacyPasskeyUsers ? /./ : 'Sign in' })
    return { wallet, bank, user, authenticator }
  }

  it('signs in to the local demo without credentials and links back to the homepage', async () => {
    const { user, wallet, bank } = await signedOut()
    const homeLink = screen.getByRole('link', { name: 'equinox, return to homepage' })
    expect(homeLink.getAttribute('href')).toBe('/')
    expect(screen.getByText('No real email, password or passcode required, just click on sign in.')).toBeTruthy()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Create a test account' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in with a passkey/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('heading', { name: 'Your wallets' })
    expect(bank.state.session?.email).toBe(DEMO_EMAIL)
    expect(wallet.isSignedIn()).toBe(true)
    expect(wallet.listAccounts()).toHaveLength(3)
    expect(bank.rules.enrolled).toHaveLength(0)
  })

  it('creates the demo wallet automatically without requesting a passcode', async () => {
    const { user, wallet, bank } = await signedOut()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('heading', { name: 'Your wallets' })
    expect(bank.state.session?.email).toBe(DEMO_EMAIL)
    expect(wallet.listAccounts()).toHaveLength(3)
  })

  it("un compte qui détient encore un passkey chez le fournisseur (ancienne version) voit pourquoi il ne peut pas entrer", async () => {
    const world = createFakeWorld({ kv: memoryKv(), scenario: { legacyPasskeyUsers: [EMAIL] } })
    const wallet = world.device('A', 'Chrome on Linux')
    const bank = fakeBankClient({ email: EMAIL, signedIn: true })
    await connectWallet({ wallet, bank })
    render(<App backend={{ wallet, bank, authenticator: fakeAuthenticator('A') }} />)
    expect(await screen.findByRole('heading', { name: 'This account cannot be opened here' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Use a different account/ })).toBeTruthy()
  })

  it('waits for the application to be ready before starting demo sign-in', async () => {
    const world = createFakeWorld({ kv: memoryKv() })
    const wallet = world.device('A', 'Chrome on Linux')
    let finishBoot!: () => void
    wallet.ready = () => new Promise<void>((resolve) => (finishBoot = resolve)) // le fournisseur met du temps à s'ouvrir
    const user = userEvent.setup()
    const bank = fakeBankClient({ email: DEMO_EMAIL })
    render(<App backend={{ wallet, bank, authenticator: fakeAuthenticator('A') }} />)
    await screen.findByRole('heading', { name: 'Sign in' })
    const signIn = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement
    expect(signIn.disabled).toBe(true)
    finishBoot()
    await waitFor(() => expect(signIn.disabled).toBe(false))
    await user.click(signIn)
    await screen.findByRole('heading', { name: 'Your wallets' })
    expect(bank.state.session?.email).toBe(DEMO_EMAIL)
  })
})
