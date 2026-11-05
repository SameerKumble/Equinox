// Wallet provider contract; the production app uses the local simulation provider.
export type Chain = 'EVM' | 'SOL' | 'BTC'

export type WalletAccount = { chain: Chain; address: string }

export type DeviceInfo = { id: string; current: boolean; label: string; createdAt: string }

/**
 * Où en est l'utilisateur sur CET appareil.
 * - signed_out: pas de session
 * - device_approval: appareil inconnu, il faut ouvrir le lien reçu par email
 * - mfa_required: le fournisseur détient encore un passkey (ancienne version du produit) et l'exige: ce compte n'est pas utilisable ici
 * - onboarding: autre étape bloquante côté fournisseur (profil incomplet, etc.)
 * - no_wallet: connecté, mais aucun wallet n'existe encore
 * - locked: les wallets existent mais leur part de clé est chiffrée ici: passcode requis
 * - ready: wallets utilisables
 */
export type AccessState =
  | 'signed_out'
  | 'device_approval'
  | 'mfa_required'
  | 'onboarding'
  | 'no_wallet'
  | 'locked'
  | 'ready'

export type AccessSnapshot = { state: AccessState; email?: string; accounts: WalletAccount[] }

/** Contrat utilisé par le produit. */
export interface WalletProvider {
  readonly name: string
  /** Résolu quand le fournisseur a fini de charger une éventuelle session existante. */
  ready(): Promise<void>
  isSignedIn(): boolean
  currentEmail(): string | undefined
  /** Photographie de l'accès sur cet appareil (appelle le fournisseur: à utiliser avec parcimonie). */
  readAccess(): Promise<AccessSnapshot>

  /** Connexion via la banque (JWT externe): la banque est la seule racine de l'identité, il n'y a pas d'autre porte d'entrée. */
  signInWithSso(jwt: string): Promise<void>
  logout(): Promise<void>
  /** Si l'URL est un lien d'approbation d'appareil, l'approuve. Retourne true si traité. */
  completeDeviceApprovalFromUrl(url: string): Promise<boolean>

  createWallets(passcode: string): Promise<void>
  listAccounts(): WalletAccount[]
  /** Déverrouille les wallets de cet appareil avec le passcode du client (jamais transmis à la banque). */
  unlock(passcode: string): Promise<void>

  /**
   * Autorisation donnée par la banque (assertion signée, portée wallet:sign ou wallet:export) pour une action sensible.
   * Le fournisseur refuse de coopérer à une signature ou à un export sans elle. Les passkeys sont ceux de la banque: le
   * fournisseur n'en connaît aucun.
   */
  stepUpWithSso(assertionJwt: string): Promise<void>

  listDevices(): Promise<DeviceInfo[]>
  revokeDevice(id: string): Promise<void>
  revokeAllDevices(): Promise<void>

  /**
   * Preuve de propriété d'une adresse (Travel Rule): signature d'un message par le wallet du client.
   * Une vraie signature MPC: elle exige l'autorisation de la banque (déjà donnée par l'appelant), comme un transfert.
   */
  signOwnershipProof(chain: Chain, message: string): Promise<{ address: string; signature: string }>

  /**
   * Envoie la monnaie native du réseau de TEST de la chaîne. Après l'autorisation de la banque (déjà donnée par l'appelant),
   * la part du client et celle du fournisseur signent ensemble. Refuse tout réseau qui n'est pas un réseau de test.
   * @param amount nombre décimal sous forme de texte, dans l'unité de la chaîne (ex. "0.001")
   */
  sendNative(chain: Chain, to: string, amount: string): Promise<{ hash: string }>

  /**
   * Affiche la clé privée d'un wallet dans `container` (iframe du fournisseur, jamais lue par le code de la page).
   * Exige le passcode et l'autorisation d'export de la banque (déjà donnée par l'appelant, après passkey).
   */
  exportPrivateKey(chain: Chain, passcode: string, container: HTMLElement): Promise<void>
}
