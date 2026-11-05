import { PasskeyError } from '../bank/webauthn'

// Transforme les erreurs brutes (SDK, réseau, banque, navigateur) en messages que le client peut comprendre.

export type AccessErrorKind =
  | 'bank_unavailable' // la banque n'a pas pu confirmer l'identité
  | 'bank_refused' // la banque a répondu, mais refuse (identifiants, règle, inscription fermée...)
  | 'reauth_required' // action sensible: la banque redemande le mot de passe
  | 'session_expired' // la session de banque n'existe plus
  | 'provider_rejected_bank' // le fournisseur ne reconnaît pas la signature de la banque (réglage, pas le client)
  | 'access_incomplete' // le fournisseur exige encore une étape (appareil, second facteur)
  | 'unauthorized'
  | 'wrong_passcode'
  | 'cancelled' // le client a refusé la biométrie, ou aucun de ses passkeys n'est sur cet appareil
  | 'passkey_exists' // cet appareil a déjà un passkey pour ce compte
  | 'passkey_unsupported' // le navigateur ne sait pas utiliser de passkey
  | 'unknown'

export type AccessError = { kind: AccessErrorKind; message: string }

/** Erreur levée quand la banque ne répond pas (distincte d'une panne du fournisseur). */
export class BankUnavailableError extends Error {
  readonly kind = 'bank_unavailable'
  constructor(detail?: string) {
    super(detail ? `Bank authority unavailable: ${detail}` : 'Bank authority unavailable')
  }
}

/** La banque a répondu, mais refuse. `code` vient du backend (invalid_credentials, reauth_required, weak_password...). */
export class BankApiError extends Error {
  readonly name = 'BankApiError'
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const raw = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

export function explain(e: unknown, during?: 'unlock'): AccessError {
  if (e instanceof PasskeyError) {
    if (e.failure === 'cancelled') return { kind: 'cancelled', message: e.message }
    if (e.failure === 'exists') return { kind: 'passkey_exists', message: e.message }
    if (e.failure === 'unsupported') return { kind: 'passkey_unsupported', message: e.message }
    return { kind: 'bank_refused', message: e.message }
  }
  if (e instanceof BankUnavailableError) {
    return { kind: 'bank_unavailable', message: 'The local demo service is unavailable. Restart the app with npm run dev and try again.' }
  }
  if (e instanceof BankApiError) {
    if (e.code === 'reauth_required') return { kind: 'reauth_required', message: e.message }
    if (e.code === 'unauthenticated') return { kind: 'session_expired', message: 'Your local demo session has ended. Sign in again.' }
    if (e.code === 'invalid_passkey') return { kind: 'bank_refused', message: 'The local demo could not verify this passkey. Try again, or use another passkey.' }
    if (e.code === 'no_passkey_here') return { kind: 'bank_refused', message: 'None of your passkeys works at this address. Add one here first.' }
    return { kind: 'bank_refused', message: e.message }
  }
  const text = raw(e)
  if (/NotAllowedError|not allowed|timed out|cancell?ed|abort/i.test(text)) {
    return { kind: 'cancelled', message: 'The passkey prompt was dismissed. Try again when you are ready.' }
  }
  if (/Failed to fetch|NetworkError|Network error/i.test(text)) {
    return { kind: 'bank_unavailable', message: 'The local demo is not responding. Restart the app with npm run dev and try again.' }
  }
  if (during === 'unlock' || /Incorrect password|wrong password|decrypt/i.test(text)) {
    return { kind: 'wrong_passcode', message: 'This passcode does not unlock the wallet. Check it and try again.' }
  }
  if (/external JWT|invalid_external_auth|JWKS|JWT is invalid/i.test(text)) {
    return {
      kind: 'provider_rejected_bank',
      message: "The wallet service does not accept the bank's sign-in token. This is a configuration problem between the bank and the wallet service, not your password.",
    }
  }
  if (/Elevated access token required|Additional authentication required|until onboarding is complete|pending MFA/i.test(text)) {
    return {
      kind: 'access_incomplete',
      message: 'The wallet service has not accepted the bank\'s authorization. Try again.',
    }
  }
  if (/Unauthorized|\b401\b/i.test(text)) {
    return {
      kind: 'unauthorized',
      message: 'The wallet service refused this request. Sign out and sign in again.',
    }
  }
  return { kind: 'unknown', message: e instanceof Error ? e.message : 'Something went wrong.' }
}
