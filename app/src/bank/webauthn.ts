import type { CreationOptions, RequestOptions } from './authority'

/* L'authentificateur du navigateur (WebAuthn): crée un passkey ou signe un défi, avec la biométrie ou le verrouillage d'écran.
   La banque pose les options (JSON) et vérifie la réponse; ce module ne fait que les convertir vers et depuis l'API du navigateur.
   Aucune clé ne passe ici: la clé privée du passkey ne quitte jamais l'authentificateur. */

export type PasskeyFailure = 'cancelled' | 'exists' | 'unsupported' | 'security'

/** Un passkey n'a pas pu être créé ou utilisé, pour une raison que le client doit comprendre. */
export class PasskeyError extends Error {
  readonly name = 'PasskeyError'
  readonly failure: PasskeyFailure
  constructor(failure: PasskeyFailure, message: string) {
    super(message)
    this.failure = failure
  }
}

/** L'interface que les parcours utilisent (réel: `browserAuthenticator`; en test: un double). Les réponses sont du JSON pour la banque. */
export interface Authenticator {
  create(options: CreationOptions): Promise<unknown>
  get(options: RequestOptions): Promise<unknown>
}

const toBuffer = (s: string): ArrayBuffer => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
const fromBuffer = (b: ArrayBuffer): string => {
  let s = ''
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function supported(): void {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) {
    throw new PasskeyError('unsupported', 'This browser cannot use passkeys. Use a recent version of Chrome, Safari, Firefox or Edge.')
  }
}

/** Les refus du navigateur sont des DOMException: on les traduit pour que l'écran dise la bonne chose. */
function translate(e: unknown): unknown {
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') return new PasskeyError('cancelled', 'No passkey was used: the prompt was dismissed, timed out, or none of your passkeys is on this device.')
    if (e.name === 'InvalidStateError') return new PasskeyError('exists', 'This device already has a passkey for your account.')
    if (e.name === 'SecurityError') return new PasskeyError('security', 'The browser refused to use a passkey for this address.')
    if (e.name === 'NotSupportedError') return new PasskeyError('unsupported', 'This device cannot create the kind of passkey the local demo requires.')
  }
  return e
}

const credentialList = (list: { id: string; transports?: string[] }[]): PublicKeyCredentialDescriptor[] =>
  list.map((c) => ({ type: 'public-key', id: toBuffer(c.id), transports: c.transports as AuthenticatorTransport[] | undefined }))

export const browserAuthenticator: Authenticator = {
  async create(o) {
    supported()
    try {
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: o.rp,
          user: { id: toBuffer(o.user.id), name: o.user.name, displayName: o.user.displayName },
          challenge: toBuffer(o.challenge),
          pubKeyCredParams: o.pubKeyCredParams,
          timeout: o.timeout,
          attestation: o.attestation,
          authenticatorSelection: o.authenticatorSelection,
          excludeCredentials: credentialList(o.excludeCredentials),
        },
      })) as PublicKeyCredential | null
      if (!cred) throw new PasskeyError('cancelled', 'No passkey was created.')
      const r = cred.response as AuthenticatorAttestationResponse
      return {
        id: cred.id,
        rawId: fromBuffer(cred.rawId),
        type: cred.type,
        response: { clientDataJSON: fromBuffer(r.clientDataJSON), attestationObject: fromBuffer(r.attestationObject), transports: r.getTransports?.() ?? [] },
      }
    } catch (e) {
      throw translate(e)
    }
  },

  async get(o) {
    supported()
    try {
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: toBuffer(o.challenge),
          rpId: o.rpId,
          timeout: o.timeout,
          userVerification: o.userVerification,
          allowCredentials: credentialList(o.allowCredentials),
        },
      })) as PublicKeyCredential | null
      if (!cred) throw new PasskeyError('cancelled', 'No passkey was used.')
      const r = cred.response as AuthenticatorAssertionResponse
      return {
        id: cred.id,
        rawId: fromBuffer(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: fromBuffer(r.clientDataJSON),
          authenticatorData: fromBuffer(r.authenticatorData),
          signature: fromBuffer(r.signature),
          userHandle: r.userHandle ? fromBuffer(r.userHandle) : undefined,
        },
      }
    } catch (e) {
      throw translate(e)
    }
  },
}
