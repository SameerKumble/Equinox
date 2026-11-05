import { loadConfig } from './config.mjs'
import { startBank } from './server.mjs'

const config = loadConfig()
const log = (m) => console.log(`[bank] ${m}`)
const bank = await startBank(config)

if (bank.apiPort !== undefined) log(`API (proxy)     http://${config.apiHost}:${bank.apiPort}  origines: ${config.allowedOrigins.join(', ')}  proxy de confiance: ${config.trustProxy ? 'oui' : 'non'}`)
if (bank.apiSocket) log(`API (admin)     socket ${bank.apiSocket}`)
log(`JWKS (publique) http://${config.jwksHost}:${bank.jwksPort}/.well-known/jwks.json`)
log(`issuer=${config.issuer} audience=${config.audience} délai de sécurité=${config.recoveryDelaySeconds}s`)

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => bank.close().then(() => process.exit(0)))
