import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hours = (n) => n * 3600

/** Configuration. Toute valeur peut être surchargée (tests) ou fixée par variable d'environnement. */
export function loadConfig(overrides = {}) {
  const env = process.env
  return {
    // L'API écoute sur un port TCP, sur un socket Unix, ou sur les deux. Sans précision: 127.0.0.1:8787.
    // En conteneur: le port (non publié sur la machine) sert au proxy HTTPS, le socket à l'administration par tunnel SSH.
    apiPort: env.BANK_API_PORT ? Number(env.BANK_API_PORT) : env.BANK_API_SOCKET ? undefined : 8787,
    apiHost: env.BANK_API_HOST ?? '127.0.0.1',
    apiSocket: env.BANK_API_SOCKET || undefined,
    jwksPort: Number(env.BANK_JWKS_PORT ?? 8788),
    // Le JWKS est public: en conteneur il doit écouter sur l'interface du conteneur pour que le proxy l'atteigne.
    jwksHost: env.BANK_JWKS_HOST ?? '127.0.0.1',
    issuer: env.BANK_ISSUER ?? 'http://localhost:8788',
    audience: env.BANK_AUDIENCE ?? 'equinox-local',
    kid: env.BANK_KID ?? 'equinox-test-1',
    dataDir: resolve(env.BANK_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url))),
    // Origines autorisées à appeler l'API (l'application, derrière un proxy de même origine), séparées par des virgules.
    allowedOrigins: (env.BANK_ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    // Derrière le proxy HTTPS (seul à joindre l'API): l'adresse du client est la dernière valeur de X-Forwarded-For.
    // À ne mettre à 1 que si l'API n'est pas joignable autrement, sinon l'en-tête est falsifiable.
    trustProxy: env.BANK_TRUST_PROXY === '1',
    // Délai de sécurité avant d'autoriser un NOUVEAU passkey (récupération ou ajout). 24 à 72 h en production.
    recoveryDelaySeconds: Number(env.BANK_RECOVERY_DELAY_SECONDS ?? 60),
    // Au-delà de ce délai depuis la dernière saisie du mot de passe, une action sensible le redemande.
    reauthWindowSeconds: Number(env.BANK_REAUTH_WINDOW_SECONDS ?? 300),
    sessionTtlSeconds: Number(env.BANK_SESSION_TTL_SECONDS ?? hours(12)),
    secureCookies: env.BANK_SECURE_COOKIES === '1',
    // Inscriptions limitées à ces adresses (jokers *). Par défaut: ouvertes (prototype).
    allowedEmails: (env.BANK_ALLOWED_EMAILS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    ...overrides,
  }
}
