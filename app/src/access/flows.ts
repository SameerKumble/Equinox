import type { AuthorizeAction, BankAuthority, BankPasskey } from '../bank/authority'
import type { Authenticator } from '../bank/webauthn'
import type { WalletProvider } from '../provider/types'
import { BankApiError, BankUnavailableError } from './errors'

// Parcours du produit. Aucune dépendance à React: on les teste avec des doubles (voir flows.test.ts).
// Les passkeys sont ceux de la banque (WebAuthn). La banque ne signe jamais et ne voit jamais le passcode: elle confirme
// l'identité, vérifie le passkey, et remet au fournisseur de wallet l'autorisation sans laquelle il refuse de signer.

export type Deps = { wallet: WalletProvider; bank: BankAuthority; authenticator: Authenticator }

/** Appelle la banque en distinguant sa panne (réseau) d'une panne du fournisseur de wallet. */
async function fromBank<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (e instanceof BankUnavailableError || e instanceof BankApiError) throw e
    throw new BankUnavailableError(e instanceof Error ? e.message : undefined)
  }
}

/** Ouvre la session du fournisseur de wallet à partir de la session de banque (la banque atteste de l'identité). */
export async function connectWallet(d: Pick<Deps, 'wallet' | 'bank'>): Promise<void> {
  const jwt = await fromBank(() => d.bank.loginToken())
  await d.wallet.signInWithSso(jwt)
}

/** Connexion à la banque SANS mot de passe, avec un passkey. La session de banque est ouverte (cookie); le wallet suit via `connectWallet`. */
export async function signInWithPasskey(d: Pick<Deps, 'bank' | 'authenticator'>): Promise<void> {
  const { challengeId, publicKey } = await fromBank(() => d.bank.authOptions('login'))
  const credential = await d.authenticator.get(publicKey)
  await fromBank(() => d.bank.authVerify({ challengeId, credential }))
}

/** Preuve de présence avec un passkey (avant d'ajouter ou de retirer un passkey): la banque garde la session « forte » quelques minutes. */
export async function proveWithPasskey(d: Pick<Deps, 'bank' | 'authenticator'>): Promise<void> {
  const { challengeId, publicKey } = await fromBank(() => d.bank.authOptions('manage'))
  const credential = await d.authenticator.get(publicKey)
  await fromBank(() => d.bank.authVerify({ challengeId, credential }))
}

export type EnrollMode = 'first' | 'proven' | 'recovery' | 'existing'
export type PasskeyEnrollment = { status: 'registered'; mode: EnrollMode; passkey?: BankPasskey } | { status: 'pending'; id: string; readyAt: number }

/**
 * Ajout d'un passkey auprès de la banque. Le premier est immédiat. Ensuite: immédiat si un passkey vient d'être vérifié
 * (second appareil), sinon c'est une récupération (appareil perdu): la banque impose un délai de sécurité, pendant lequel le
 * client peut annuler depuis un autre appareil. Rend alors `pending` sans rien créer: il faut rappeler une fois `readyAt` passé.
 * Peut lever `reauth_required` (la banque redemande le mot de passe quand la dernière saisie est ancienne).
 */
export async function enrollPasskey(
  d: Deps,
  o: { label: string; password?: string; onStep?: (s: 'bank' | 'passkey' | 'confirm') => void },
): Promise<PasskeyEnrollment> {
  o.onStep?.('bank')
  const start = await fromBank(() => d.bank.registerOptions(o.password))
  if (start.status === 'pending') return { status: 'pending', id: start.id, readyAt: start.readyAt }
  o.onStep?.('passkey')
  const credential = await d.authenticator.create(start.publicKey)
  o.onStep?.('confirm')
  const { passkey } = await fromBank(() => d.bank.registerVerify({ challengeId: start.challengeId, credential, label: o.label }))
  return { status: 'registered', mode: start.mode, passkey }
}

/**
 * Ajout d'un passkey depuis la page Sécurité. Avec `proof`, un passkey déjà enregistré confirme d'abord (second appareil, sans délai).
 * Sans: la récupération, avec son délai de sécurité (appareil perdu).
 */
export async function addPasskey(
  d: Deps,
  o: { label: string; password?: string; proof: boolean; onStep?: (s: 'bank' | 'passkey' | 'confirm') => void },
): Promise<PasskeyEnrollment> {
  if (o.proof) await proveWithPasskey(d)
  return enrollPasskey(d, o)
}

/**
 * Autorise une signature (ou l'export de la clé). La banque vérifie le client (son passkey, lié au transfert qu'elle a validé;
 * à défaut le mot de passe pour signer) puis remet au fournisseur un jeton court sans lequel il refuse de coopérer.
 * Rend la méthode employée. Peut lever `reauth_required` quand la banque redemande le mot de passe.
 */
export async function authorizeSigning(
  d: Deps,
  o: { action?: AuthorizeAction; authorizationId?: string; password?: string } = {},
): Promise<'passkey' | 'password'> {
  const begin = await fromBank(() => d.bank.authorizeBegin({ action: o.action ?? 'sign', authorizationId: o.authorizationId, password: o.password }))
  let assertion: string
  if (begin.method === 'passkey') {
    const credential = await d.authenticator.get(begin.publicKey)
    assertion = (await fromBank(() => d.bank.authorizeFinish({ challengeId: begin.challengeId, credential }))).assertion
  } else {
    assertion = begin.assertion
  }
  await d.wallet.stepUpWithSso(assertion)
  return begin.method
}

/** Création du wallet. Reprenable: ne crée que ce qui manque (wallets, puis premier passkey de la banque). */
export async function setupWallet(
  d: Deps,
  passcode: string,
  o: { label: string; password?: string; onStep?: (s: 'wallets' | 'bank' | 'passkey' | 'confirm') => void },
): Promise<PasskeyEnrollment> {
  o.onStep?.('wallets')
  await d.wallet.createWallets(passcode)
  if ((await fromBank(() => d.bank.passkeys())).length > 0) return { status: 'registered', mode: 'existing' }
  return enrollPasskey(d, o)
}

export const MIN_PASSCODE = 8

export function passcodeProblem(passcode: string, repeat: string): string | null {
  if (passcode.length < MIN_PASSCODE) return `Use at least ${MIN_PASSCODE} characters.`
  if (passcode !== repeat) return 'The two passcodes are different.'
  return null
}

/** Retirer un passkey exige d'en vérifier un à l'instant, et il en reste toujours au moins un. */
export async function removePasskeyGuarded(d: Deps, id: string): Promise<void> {
  const list = await fromBank(() => d.bank.passkeys())
  if (list.length <= 1) throw new Error('Keep at least one passkey. Add another one first.')
  await proveWithPasskey(d)
  await fromBank(() => d.bank.removePasskey(id))
}
