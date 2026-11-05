import type { CreationOptions, RequestOptions } from '../bank/authority'
import { PasskeyError, type Authenticator } from '../bank/webauthn'

/* Double de test de l'authentificateur du navigateur. Il garde LES passkeys de CET appareil (leurs identifiants): un appareil
   neuf n'en a aucun, un appareil qui a créé un passkey peut le présenter. Une invite refusée (biométrie annulée) se simule.
   Les réponses ne portent pas de vraie cryptographie: celle-ci est vérifiée par les tests du backend (server/test), qui
   utilisent un authentificateur logiciel réel. Ici on vérifie que les parcours font les bons appels, dans le bon ordre. */

export type FakeAuthenticator = Authenticator & {
  /** Identifiants des passkeys présents sur cet appareil. */
  readonly credentials: string[]
  /** Nombre d'invites (création ou utilisation) montrées au client. */
  readonly prompts: number
  /** La prochaine invite est refusée par le client. */
  refuseNext(): void
  /** Appareil perdu: il n'a plus aucun passkey. */
  wipe(): void
  /** Passkeys synchronisés d'un autre appareil (gestionnaire de mots de passe du système): cet appareil les présente aussi. */
  adopt(...ids: string[]): void
}

let created = 0

export function fakeAuthenticator(seed: string = ''): FakeAuthenticator {
  const ids: string[] = []
  let refuse = false
  let prompts = 0
  const prompt = () => {
    prompts++
    if (refuse) {
      refuse = false
      throw new PasskeyError('cancelled', 'No passkey was used: the prompt was dismissed, timed out, or none of your passkeys is on this device.')
    }
  }
  return {
    get credentials() {
      return ids
    },
    get prompts() {
      return prompts
    },
    refuseNext: () => void (refuse = true),
    wipe: () => void (ids.length = 0),
    adopt: (...more) => void ids.push(...more.filter((i) => !ids.includes(i))),

    async create(o: CreationOptions) {
      prompt()
      if (o.excludeCredentials.some((c) => ids.includes(c.id))) throw new PasskeyError('exists', 'This device already has a passkey for your account.')
      const id = `cred-${seed}${++created}`
      ids.push(id)
      return { id, type: 'public-key', challenge: o.challenge, userId: o.user.id, response: { transports: ['internal'] } }
    },

    async get(o: RequestOptions) {
      const usable = o.allowCredentials.length > 0 ? ids.filter((i) => o.allowCredentials.some((c) => c.id === i)) : ids
      prompt()
      if (usable.length === 0) throw new PasskeyError('cancelled', 'No passkey was used: the prompt was dismissed, timed out, or none of your passkeys is on this device.')
      return { id: usable[0], type: 'public-key', challenge: o.challenge, response: {} }
    },
  }
}
