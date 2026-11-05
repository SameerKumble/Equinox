import { describe, expect, it, vi } from 'vitest'
import { PasskeyError } from '../bank/webauthn'
import { fakeAuthenticator } from '../testing/fakeAuthenticator'
import { fakeBank } from '../testing/fakeBank'
import { createFakeWorld, memoryKv, type Scenario } from '../testing/fakeWallet'
import type { WalletProvider } from '../provider/types'
import { BankApiError, BankUnavailableError, explain } from './errors'
import { addPasskey, authorizeSigning, connectWallet, enrollPasskey, passcodeProblem, proveWithPasskey, removePasskeyGuarded, setupWallet, signInWithPasskey } from './flows'

const EMAIL = 'client@example.ch'
const PASS = 'correct horse battery'
const LABEL = 'Chrome on Linux'
const RECIPIENT = '0x6DB8A8CDE4fF95d95570589D850136D2B0932b1D'
const TEN_MIN = 10 * 60_000 + 1000

/** Un monde (fournisseur + une banque) avec deux appareils A et B. L'horloge est maîtrisée pour les délais de sécurité. */
function setup(scenario?: Partial<Scenario>, bankOptions: { passwordFor?: string } = {}) {
  const clock = { t: 1_800_000_000_000 }
  const world = createFakeWorld({ kv: memoryKv(), scenario })
  const bank = fakeBank({ email: EMAIL, now: () => clock.t, ...bankOptions })
  const A = { wallet: world.device('A', 'Chrome on Linux'), bank, authenticator: fakeAuthenticator('A') }
  const B = { wallet: world.device('B', 'Safari on iPhone'), bank, authenticator: fakeAuthenticator('B') }
  return { world, bank, clock, A, B }
}
type Setup = ReturnType<typeof setup>
const state = async (w: WalletProvider) => (await w.readAccess()).state
const lastMail = (world: Setup['world']) => world.mailbox().slice(-1)[0]
const approve = (world: Setup['world'], w: WalletProvider) => w.completeDeviceApprovalFromUrl(lastMail(world).link)
const create = (d: Setup['A'], passcode = PASS, password?: string) => setupWallet(d, passcode, { label: LABEL, password })

/** Le client a créé son wallet sur A (premier passkey). */
async function onboarded(scenario?: Partial<Scenario>, bankOptions: { passwordFor?: string } = {}) {
  const s = setup(scenario, bankOptions)
  await connectWallet(s.A)
  await create(s.A, PASS, bankOptions.passwordFor)
  return s
}
const sendOk = (w: WalletProvider) => w.sendNative('EVM', RECIPIENT, '0.001')

/* ------------------------------------------------------------------ */

describe('premier appareil', () => {
  it('crée les wallets puis le premier passkey de la banque, sans attendre', async () => {
    const { A, bank } = setup()
    await connectWallet(A)
    expect(await state(A.wallet)).toBe('no_wallet')
    const done = await create(A)
    expect(done).toMatchObject({ status: 'registered', mode: 'first' })
    expect(await state(A.wallet)).toBe('ready')
    expect(A.wallet.listAccounts().map((a) => a.chain).sort()).toEqual(['BTC', 'EVM', 'SOL'])
    expect(bank.enrolled).toHaveLength(1)
    expect(A.authenticator.credentials).toHaveLength(1)
    expect(await A.wallet.listDevices()).toHaveLength(1)
  })

  it('est reprenable: une panne de la banque ne crée ni doublon ni blocage', async () => {
    const { A, bank } = setup()
    await connectWallet(A)
    const down = { ...A, bank: { ...bank, passkeys: () => Promise.reject(new TypeError('Failed to fetch')) } as typeof bank }
    await expect(create(down)).rejects.toBeInstanceOf(BankUnavailableError)
    expect(A.wallet.listAccounts()).toHaveLength(3) // les wallets existent déjà: on ne perd rien
    expect(await create(A)).toMatchObject({ status: 'registered', mode: 'first' })
    expect(A.wallet.listAccounts()).toHaveLength(3)
  })

  it("une invite biométrique refusée laisse les wallets et n'impose aucun délai: on réessaie tout de suite", async () => {
    const { A, bank } = setup()
    await connectWallet(A)
    A.authenticator.refuseNext()
    const first = await create(A).catch((e) => e)
    expect(first).toBeInstanceOf(PasskeyError)
    expect(explain(first).kind).toBe('cancelled')
    expect(A.wallet.listAccounts()).toHaveLength(3)
    expect(bank.enrolled).toHaveLength(0)
    expect(await enrollPasskey(A, { label: LABEL })).toMatchObject({ status: 'registered', mode: 'first' }) // pas de délai
    expect(bank.enrolled).toHaveLength(1)
  })

  it("un passkey déjà enregistré n'est pas recréé quand on reprend la création", async () => {
    const { A, bank } = await onboarded()
    expect(await create(A)).toEqual({ status: 'registered', mode: 'existing' })
    expect(bank.enrolled).toHaveLength(1)
  })

  it('le mot de passe de la banque est redemandé quand elle le juge nécessaire, et une erreur claire remonte', async () => {
    const { A } = setup({}, { passwordFor: 'bank password' })
    await connectWallet(A)
    const first = await create(A).catch((e) => e)
    expect(first).toBeInstanceOf(BankApiError)
    expect(explain(first).kind).toBe('reauth_required')
    expect(A.wallet.listAccounts()).toHaveLength(3)
    const wrong = await create(A, PASS, 'nope').catch((e) => e)
    expect(explain(wrong).message).toBe('Password is incorrect')
    expect(await create(A, PASS, 'bank password')).toMatchObject({ status: 'registered', mode: 'first' })
  })
})

describe('connexion par passkey', () => {
  it("sans mot de passe: le passkey de l'appareil ouvre la session de la banque", async () => {
    const { A, bank } = await onboarded()
    await signInWithPasskey(A)
    expect(bank.logins).toBe(1)
    expect(A.authenticator.prompts).toBeGreaterThanOrEqual(2) // création + connexion
  })

  it('sur un appareil sans passkey, aucune connexion; une invite refusée non plus', async () => {
    const { A, B, bank } = await onboarded()
    await expect(signInWithPasskey(B)).rejects.toBeInstanceOf(PasskeyError)
    A.authenticator.refuseNext()
    await expect(signInWithPasskey(A)).rejects.toBeInstanceOf(PasskeyError)
    expect(bank.logins).toBe(0)
  })

  it('un passkey synchronisé fonctionne aussi sur un autre appareil', async () => {
    const { A, B, bank } = await onboarded()
    B.authenticator.adopt(...A.authenticator.credentials)
    await signInWithPasskey(B)
    expect(bank.logins).toBe(1)
  })
})

describe('signer une transaction', () => {
  it("avec un passkey: la banque lie l'autorisation au transfert, le fournisseur reçoit son jeton, la signature réussit", async () => {
    const { A, bank } = await onboarded()
    const stepUp = vi.spyOn(A.wallet, 'stepUpWithSso')
    expect(await authorizeSigning(A, { authorizationId: 'auth-1' })).toBe('passkey')
    expect(stepUp).toHaveBeenCalledOnce()
    expect(JSON.parse(atob(stepUp.mock.calls[0][0].slice(5))).scope).toBe('wallet:sign')
    expect(bank.signed).toEqual([{ method: 'passkey', authorizationId: 'auth-1' }])
    expect((await sendOk(A.wallet)).hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("sans l'autorisation de la banque, le fournisseur refuse de signer, même un client sans aucun passkey", async () => {
    const { A } = await onboarded()
    await expect(sendOk(A.wallet)).rejects.toThrow('Elevated access token required')
    await expect(A.wallet.signOwnershipProof('BTC', 'hello')).rejects.toThrow('Elevated access token required')
    const fresh = setup()
    await connectWallet(fresh.A)
    A.authenticator.wipe()
    await expect(sendOk(A.wallet)).rejects.toThrow('Elevated access token required')
  })

  it("une autorisation ne sert qu'une signature: la suivante en demande une nouvelle", async () => {
    const { A } = await onboarded()
    await authorizeSigning(A, { authorizationId: 'auth-1' })
    await sendOk(A.wallet)
    await expect(sendOk(A.wallet)).rejects.toThrow('Elevated access token required')
    await authorizeSigning(A, { authorizationId: 'auth-2' })
    await sendOk(A.wallet)
  })

  it("une décision de la banque ne donne qu'une autorisation", async () => {
    const { A } = await onboarded()
    await authorizeSigning(A, { authorizationId: 'auth-1' })
    const again = await authorizeSigning(A, { authorizationId: 'auth-1' }).catch((e) => e)
    expect(again).toBeInstanceOf(BankApiError)
    expect(again.code).toBe('authorization_used')
  })

  it("un passkey absent de cet appareil, une invite refusée: aucune autorisation, rien n'est signé", async () => {
    const { A, B, bank } = await onboarded()
    const before = bank.signed.length
    await expect(authorizeSigning(B, { authorizationId: 'auth-1' })).rejects.toBeInstanceOf(PasskeyError)
    A.authenticator.refuseNext()
    await expect(authorizeSigning(A, { authorizationId: 'auth-2' })).rejects.toBeInstanceOf(PasskeyError)
    expect(bank.signed).toHaveLength(before)
    await expect(sendOk(A.wallet)).rejects.toThrow('Elevated access token required')
  })

  it("sans passkey (compte pas encore équipé), le mot de passe suffit, et il est redemandé quand la banque le veut", async () => {
    const { A, bank } = setup({}, { passwordFor: 'bank password' })
    await connectWallet(A)
    A.authenticator.refuseNext()
    await create(A, PASS, 'bank password').catch(() => undefined) // wallets créés, passkey refusé: le compte n'a toujours pas de passkey
    expect(bank.enrolled).toHaveLength(0)
    await expect(authorizeSigning(A)).rejects.toMatchObject({ code: 'reauth_required' })
    expect(await authorizeSigning(A, { password: 'bank password' })).toBe('password')
    expect(bank.signed).toEqual([{ method: 'password', authorizationId: undefined }])
  })

  it("une banque injoignable n'autorise rien", async () => {
    const { A } = await onboarded()
    const stepUp = vi.spyOn(A.wallet, 'stepUpWithSso')
    const down = { ...A, bank: { ...A.bank, authorizeBegin: () => Promise.reject(new TypeError('Failed to fetch')) } as typeof A.bank }
    await expect(authorizeSigning(down)).rejects.toBeInstanceOf(BankUnavailableError)
    expect(stepUp).not.toHaveBeenCalled()
  })
})

describe('exporter la clé', () => {
  it('exige un passkey et le passcode; la clé s\'affiche dans le cadre prévu', async () => {
    const { A, bank } = await onboarded()
    const box = { textContent: '' } as unknown as HTMLElement
    await expect(A.wallet.exportPrivateKey('BTC', PASS, box)).rejects.toThrow('Elevated access token required')
    expect(await authorizeSigning(A, { action: 'export' })).toBe('passkey')
    expect(bank.exported).toBe(1)
    await A.wallet.exportPrivateKey('BTC', PASS, box)
    expect(box.textContent).toMatch(/^FAKE PRIVATE KEY for BTC: [0-9a-f]{64}$/)
    // Un jeton d'export ne sert qu'une fois, et un mauvais passcode ne révèle rien.
    await expect(A.wallet.exportPrivateKey('BTC', PASS, box)).rejects.toThrow('Elevated access token required')
    await authorizeSigning(A, { action: 'export' })
    const empty = { textContent: '' } as unknown as HTMLElement
    await expect(A.wallet.exportPrivateKey('BTC', 'wrong passcode', empty)).rejects.toThrow('Incorrect password')
    expect(empty.textContent).toBe('')
  })

  it("sans passkey, l'export est refusé par la banque (le mot de passe ne suffit jamais)", async () => {
    const { A } = setup()
    await connectWallet(A)
    A.authenticator.refuseNext()
    await create(A).catch(() => undefined)
    const err = await authorizeSigning(A, { action: 'export' }).catch((e) => e)
    expect(err).toBeInstanceOf(BankApiError)
    expect(err.code).toBe('no_passkey')
  })
})

describe('récupération sur un nouvel appareil (le modèle du projet)', () => {
  async function twoDevices(scenario?: Partial<Scenario>) {
    const s = await onboarded(scenario)
    await connectWallet(s.B)
    return s
  }

  it("lien d'approbation, passcode, mêmes adresses; puis le nouveau passkey passe par le délai de la banque et signe", async () => {
    const { world, clock, bank, A, B } = await twoDevices()
    expect(await state(B.wallet)).toBe('device_approval')
    expect(lastMail(world)).toMatchObject({ to: EMAIL })
    expect(await approve(world, B.wallet)).toBe(true)

    // Aucun passkey fournisseur ne bloque la connexion: le wallet se déverrouille avec le passcode seul.
    expect(await state(B.wallet)).toBe('locked')
    await expect(B.wallet.unlock('not the passcode')).rejects.toThrow('Incorrect password')
    await B.wallet.unlock(PASS)
    expect(await state(B.wallet)).toBe('ready')
    expect(B.wallet.listAccounts()).toEqual(A.wallet.listAccounts())

    // Mais signer exige un passkey, et B n'en a aucun: la banque n'autorise rien.
    await expect(authorizeSigning(B, { authorizationId: 'auth-1' })).rejects.toBeInstanceOf(PasskeyError)
    await expect(sendOk(B.wallet)).rejects.toThrow('Elevated access token required')

    // Récupération: la preuve forte de la session d'origine a expiré, la banque impose son délai.
    clock.t += TEN_MIN
    const waiting = await enrollPasskey(B, { label: 'Safari on iPhone' })
    expect(waiting).toMatchObject({ status: 'pending' })
    expect(bank.enrolled).toHaveLength(1)
    clock.t += 30_000
    expect((await enrollPasskey(B, { label: 'Safari on iPhone' })).status).toBe('pending')
    clock.t += 31_000
    expect(await enrollPasskey(B, { label: 'Safari on iPhone' })).toMatchObject({ status: 'registered', mode: 'recovery' })
    expect(bank.enrolled).toHaveLength(2)

    expect(await authorizeSigning(B, { authorizationId: 'auth-2' })).toBe('passkey')
    expect((await sendOk(B.wallet)).hash).toMatch(/^0x/)
  })

  it("une demande annulée depuis un autre appareil ne débloque rien: une nouvelle demande repart avec son délai", async () => {
    const { world, clock, bank, B } = await twoDevices()
    await approve(world, B.wallet)
    clock.t += TEN_MIN
    await enrollPasskey(B, { label: LABEL })
    const [req] = bank.pendingRequests()
    expect(req.scope).toBe('passkey:enroll')
    bank.cancel(req.id)
    expect(bank.pendingRequests()).toHaveLength(0)
    clock.t += 120_000
    expect((await enrollPasskey(B, { label: LABEL })).status).toBe('pending')
  })

  it("une invite refusée après le délai se rejoue sans nouvelle attente, trois fois au plus, puis le délai repart", async () => {
    const { world, clock, B } = await twoDevices()
    await approve(world, B.wallet)
    clock.t += TEN_MIN
    await enrollPasskey(B, { label: LABEL })
    clock.t += 61_000
    for (let i = 0; i < 3; i++) {
      B.authenticator.refuseNext()
      await expect(enrollPasskey(B, { label: LABEL })).rejects.toBeInstanceOf(PasskeyError)
      clock.t += 60_000
    }
    expect((await enrollPasskey(B, { label: LABEL })).status).toBe('pending')
  })

  it("un passkey d'un autre appareil prouve la présence: le nouveau passkey est immédiat, sans délai (second appareil)", async () => {
    const { world, bank, A, B } = await twoDevices()
    await approve(world, B.wallet)
    // Comme avec un téléphone proche: le passkey existant prouve, le nouveau est créé sur l'ordinateur.
    const crossDevice = { ...B, authenticator: { create: B.authenticator.create, get: A.authenticator.get } }
    const done = await addPasskey(crossDevice, { label: 'Laptop', proof: true })
    expect(done).toMatchObject({ status: 'registered', mode: 'proven' })
    expect(bank.enrolled).toHaveLength(2)
  })

  it("« je ne peux pas utiliser mes passkeys »: sans preuve, la banque impose son délai", async () => {
    const { world, clock, bank, B } = await twoDevices()
    await approve(world, B.wallet)
    clock.t += TEN_MIN
    expect((await addPasskey(B, { label: LABEL, proof: false })).status).toBe('pending')
    expect(bank.enrolled).toHaveLength(1)
  })

  it("le lien d'approbation est à usage unique", async () => {
    const { world, B } = await twoDevices()
    const link = lastMail(world).link
    await B.wallet.completeDeviceApprovalFromUrl(link)
    await expect(B.wallet.completeDeviceApprovalFromUrl(link)).rejects.toThrow('Invalid or expired')
  })

  it("sans approbation d'appareil, aucun wallet n'est accessible, et la banque ne peut pas y suppléer", async () => {
    const { B } = await twoDevices()
    await expect(B.wallet.unlock(PASS)).rejects.toThrow('onboarding is complete')
    await expect(B.wallet.signOwnershipProof('BTC', 'hello')).rejects.toThrow('onboarding is complete')
    await expect(B.wallet.stepUpWithSso(JSON.stringify({}))).rejects.toThrow()
  })

  it("après « révoquer tous les appareils » sur A, B doit être réapprouvé", async () => {
    const { world, A, B } = await twoDevices()
    await approve(world, B.wallet)
    await A.wallet.revokeAllDevices()
    expect(await A.wallet.listDevices()).toHaveLength(1)
    await B.wallet.logout()
    await connectWallet(B)
    expect(await state(B.wallet)).toBe('device_approval')
  })

  it("un compte qui détient encore un passkey chez le fournisseur (ancienne version) reste bloqué, avec un état explicite", async () => {
    const { A } = setup({ legacyPasskeyUsers: [EMAIL] })
    await connectWallet(A)
    expect(await state(A.wallet)).toBe('mfa_required')
    await expect(A.wallet.createWallets(PASS)).rejects.toThrow('onboarding is complete')
  })
})

describe('passkeys', () => {
  it("retirer exige un passkey vérifié à l'instant, et il en reste toujours un", async () => {
    const { A, bank, world, clock, B } = await onboarded()
    const [only] = bank.enrolled
    await expect(removePasskeyGuarded(A, only.id)).rejects.toThrow('Keep at least one passkey')
    await connectWallet(B)
    await approve(world, B.wallet)
    const crossDevice = { ...B, authenticator: { create: B.authenticator.create, get: A.authenticator.get } }
    await addPasskey(crossDevice, { label: 'Laptop', proof: true })
    expect(bank.enrolled).toHaveLength(2)

    clock.t += TEN_MIN // la preuve forte a expiré: retirer en demande une nouvelle
    A.authenticator.refuseNext()
    await expect(removePasskeyGuarded(A, only.id)).rejects.toBeInstanceOf(PasskeyError)
    expect(bank.enrolled).toHaveLength(2)
    await removePasskeyGuarded(A, only.id)
    expect(bank.enrolled).toHaveLength(1)
    await expect(proveWithPasskey(A)).rejects.toBeInstanceOf(PasskeyError) // le passkey retiré n'ouvre plus rien
  })
})

describe('messages', () => {
  it('passcode', () => {
    expect(passcodeProblem('short', 'short')).toMatch(/at least 8/)
    expect(passcodeProblem('long enough', 'different')).toMatch(/different/)
    expect(passcodeProblem('long enough', 'long enough')).toBeNull()
  })
  it('erreurs', () => {
    expect(explain(new TypeError('Failed to fetch')).kind).toBe('bank_unavailable')
    expect(explain(new Error('Unauthorized')).kind).toBe('unauthorized')
    expect(explain(new DOMException('x', 'NotAllowedError')).kind).toBe('cancelled')
    expect(explain(new PasskeyError('cancelled', 'No passkey was used')).kind).toBe('cancelled')
    expect(explain(new PasskeyError('exists', 'This device already has a passkey')).kind).toBe('passkey_exists')
    expect(explain(new PasskeyError('unsupported', 'This browser cannot use passkeys')).kind).toBe('passkey_unsupported')
    expect(explain(new Error('anything'), 'unlock').kind).toBe('wrong_passcode')
    expect(explain(new Error('Elevated access token required')).kind).toBe('access_incomplete')
    expect(explain(new Error('Error authenticating with external JWT')).kind).toBe('provider_rejected_bank')
    expect(explain(new BankUnavailableError('HTTP 502')).kind).toBe('bank_unavailable')
    expect(explain(new BankApiError(401, 'invalid_credentials', 'Email or password is incorrect'))).toEqual({ kind: 'bank_refused', message: 'Email or password is incorrect' })
    expect(explain(new BankApiError(401, 'unauthenticated', 'Sign in first')).kind).toBe('session_expired')
    expect(explain(new BankApiError(401, 'invalid_passkey', 'x')).message).toMatch(/could not verify this passkey/)
  })
})
