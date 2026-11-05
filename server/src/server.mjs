import { createServer } from 'node:http'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from './db.mjs'
import { createApi } from './handlers.mjs'
import { loadSigner } from './jwt.mjs'
import { createChainReader } from './chain.mjs'

const listen = (server, port, host = '127.0.0.1') =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server.address().port))
  })

/** Socket Unix: seul son propriétaire peut s'y connecter (0600). Un reste d'arrêt brutal est supprimé d'abord. */
const listenOnSocket = (server, path) =>
  new Promise((resolve, reject) => {
    rmSync(path, { force: true })
    server.once('error', reject)
    server.listen(path, () => {
      chmodSync(path, 0o600)
      resolve(path)
    })
  })

/**
 * Deux serveurs, volontairement séparés:
 * - API (derrière le proxy HTTPS de l'application, qui ne relaie que /api): comptes, autorisations, règles, audit;
 * - JWKS (publique): uniquement la clé PUBLIQUE, que le fournisseur de wallet va chercher pour vérifier les jetons.
 * Le JWKS n'expose jamais autre chose que cette clé publique.
 * L'API peut écouter sur un port TCP, sur un socket Unix, ou sur les deux (un serveur par adresse, même traitement).
 */
export async function startBank(config, { now } = {}) {
  mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(join(config.dataDir, 'bank.sqlite'))
  const signer = loadSigner(config.dataDir, config)
  if (!config.apiSocket && config.apiPort === undefined) throw new Error('Aucune adresse d\'écoute pour l\'API (BANK_API_PORT ou BANK_API_SOCKET)')
  const chain = createChainReader({ dataDir: config.dataDir, now })
  const handle = createApi({ config, db, signer, chain, now })
  const apis = []
  const serveApi = (start) => {
    const server = createServer(handle)
    apis.push(server)
    return start(server)
  }
  const jwks = createServer((req, res) => {
    if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/.well-known/jwks.json') {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'public, max-age=300')
      return res.end(JSON.stringify(signer.jwks()))
    }
    res.statusCode = 404
    res.end()
  })
  const apiSocket = config.apiSocket ? await serveApi((s) => listenOnSocket(s, config.apiSocket)) : undefined
  const apiPort = config.apiPort !== undefined ? await serveApi((s) => listen(s, config.apiPort, config.apiHost)) : undefined
  const jwksPort = await listen(jwks, config.jwksPort, config.jwksHost)

  return {
    apiPort,
    apiSocket,
    jwksPort,
    db,
    signer,
    close: () =>
      Promise.all([...apis, jwks].map((s) => new Promise((r) => s.close(r)))).then(() => {
        db.close()
      }),
  }
}
