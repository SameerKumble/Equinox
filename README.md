# Equinox

Equinox is an offline wallet simulation of a bank product for customer's ownership of keys. Accounts, passkeys, balances, policies, and simulated transfers use the local browser and local service only. The app does not contact a bank, blockchain, wallet provider, explorer, or other internet service. It does not create real private keys or broadcast transactions.

## Run locally

Requirements: Node.js 22.13 or newer.

```powershell
cd app
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite development server starts the local demo API automatically; a second terminal or remote bank is not needed. Keep the hostname as `localhost` for browser passkey support.

Click **Sign in** to open the local demo. No real email, password, or passcode is required. Send forms use a fixed demo recipient address that cannot be edited. Wallet data is stored in this browser. The demo API stores its local database and signing key under `server/data`.

To run the frontend checks:

```powershell
npm test
npm run build
```

## Offline behavior

- The frontend only sends same-origin `/api` requests, which Vite proxies to the local API at `127.0.0.1:8787`.
- The local API binds to loopback and uses a local simulated ledger. It does not query public chain RPCs or explorers.
- A restrictive Content Security Policy disallows external connections.
- Repeated incorrect-password attempts retain the local account lockout. Routine request throttling is disabled.

To reset the demo, stop the app and remove the specific local data files under `server/data`, then clear Equinox site data in the browser. Do not remove the whole project directory.
