// Ce que le produit attend de la banque pour ouvrir un wallet, gérer les passkeys et autoriser une signature.
//
// Les passkeys sont ceux de la BANQUE (WebAuthn): elle les enregistre, les exige pour se connecter sans mot de passe et pour
// signer, et les retire. Le fournisseur de wallet n'en connaît aucun. La banque ne signe jamais: elle remet au fournisseur une
// autorisation courte (signer, exporter la clé) sans laquelle il refuse de coopérer, ou elle refuse.
//
// L'implémentation réelle est `bankApi` (bank/api.ts), qui parle au backend de la banque. Cette interface existe pour
// que les parcours (access/flows.ts) soient testables sans réseau.

/** Options de création d'un passkey, telles que la banque les renvoie (JSON; valeurs binaires en base64url). */
export type CreationOptions = {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  timeout?: number
  attestation?: 'none'
  authenticatorSelection?: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' }
  excludeCredentials: { type: 'public-key'; id: string; transports?: string[] }[]
}

/** Options d'utilisation d'un passkey (connexion, preuve, autorisation de signer). */
export type RequestOptions = {
  challenge: string
  rpId: string
  timeout?: number
  userVerification: 'required'
  allowCredentials: { type: 'public-key'; id: string; transports?: string[] }[]
}

export type BankPasskey = { id: string; label: string; createdAt: number; lastUsedAt: number | null; synced: boolean }

/**
 * Ajout d'un passkey. `first`: le tout premier, tout de suite. `proven`: un passkey vient d'être vérifié (second appareil), tout de suite.
 * `recovery`: aucun passkey utilisable (appareil perdu), après un délai de sécurité pendant lequel le client peut annuler.
 */
export type EnrollStart =
  | { status: 'ready'; mode: 'first' | 'proven' | 'recovery'; challengeId: string; publicKey: CreationOptions }
  | { status: 'pending'; id: string; readyAt: number; retryAfterSeconds: number }

/** Le client a-t-il un passkey? Oui: la banque pose un défi. Non: le mot de passe récent suffit pour signer (jamais pour exporter). */
export type AuthorizeStart =
  | { method: 'passkey'; challengeId: string; publicKey: RequestOptions }
  | { method: 'password'; assertion: string }

export type AuthorizeAction = 'sign' | 'export'

export interface BankAuthority {
  loginToken(): Promise<string>
  passkeys(): Promise<BankPasskey[]>
  registerOptions(password?: string): Promise<EnrollStart>
  registerVerify(r: { challengeId: string; credential: unknown; label: string }): Promise<{ passkey: BankPasskey }>
  removePasskey(id: string): Promise<unknown>
  /** Défi pour se connecter sans mot de passe (`login`, sans session) ou pour prouver sa présence (`manage`, avec session). */
  authOptions(purpose: 'login' | 'manage'): Promise<{ challengeId: string; publicKey: RequestOptions }>
  authVerify(r: { challengeId: string; credential: unknown }): Promise<unknown>
  /** `authorizationId`: le transfert que la banque a validé et que le client va signer (le défi du passkey y est lié). */
  authorizeBegin(r: { action: AuthorizeAction; authorizationId?: string; password?: string }): Promise<AuthorizeStart>
  authorizeFinish(r: { challengeId: string; credential: unknown }): Promise<{ assertion: string }>
}
