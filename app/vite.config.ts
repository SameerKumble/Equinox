import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { loadConfig } from '../server/src/config.mjs'
import { startBank } from '../server/src/server.mjs'
import { DEMO_EMAIL } from './src/access/demo'

function localBankPlugin(): Plugin {
  let bank: Awaited<ReturnType<typeof startBank>> | undefined
  const start = async () => {
    const config = loadConfig({
      apiPort: 8787,
      apiHost: '127.0.0.1',
      apiSocket: undefined,
      jwksPort: 8788,
      jwksHost: '127.0.0.1',
      issuer: 'http://localhost:8788',
      allowedOrigins: ['http://localhost:5173', 'http://localhost:4173'],
    })
    const allowedEmails = config.allowedEmails
    if (!Array.isArray(allowedEmails) || !allowedEmails.every((email): email is string => typeof email === 'string')) {
      throw new TypeError('The local bank returned an invalid allowed-email configuration.')
    }
    bank ??= await startBank(
      { ...config, allowedEmails: [...new Set([...allowedEmails, DEMO_EMAIL])] },
    )
  }
  const stop = async () => {
    if (!bank) return
    const running = bank
    bank = undefined
    await running.close()
  }

  return {
    name: 'equinox-local-bank',
    configureServer: async (server) => {
      await start()
      server.httpServer?.once('close', () => void stop())
    },
    configurePreviewServer: async (server) => {
      await start()
      server.httpServer.once('close', () => void stop())
    },
  }
}

export default defineConfig(({ mode }) => ({
    plugins: [
      react(),
      nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
      ...(mode === 'test' ? [] : [localBankPlugin()]),
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
    },
    preview: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } } },
}))
