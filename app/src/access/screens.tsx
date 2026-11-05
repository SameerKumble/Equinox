import { useState, type ReactNode } from 'react'
import { Loader2, LogOut } from 'lucide-react'
import { Field, Wordmark } from '../Panels'
import { useAccess } from './AccessProvider'

/* Écrans affichés tant que le wallet n'est pas prêt sur cet appareil. Chaque écran a une seule tâche et un seul bouton principal. */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <a className="wordmark-home" href="/" aria-label="equinox, return to homepage">
          <Wordmark />
        </a>
        <h1>Self-custody, with a bank behind it.</h1>
        <ul>
          <li>Your key is never in one place</li>
          <li>The bank can refuse a transfer, never sign one</li>
          <li>Recover your wallet without a seed phrase</li>
        </ul>
      </aside>
      <main className="auth-card" id="main">
        {children}
      </main>
    </div>
  )
}

function Notice() {
  const a = useAccess()
  if (!a.error) return null
  return (
    <div className="stack" aria-live="polite">
      {a.error && (
        <p className="hint" role="alert">
          {a.error.message}
        </p>
      )}
    </div>
  )
}

function Working() {
  const a = useAccess()
  if (!a.busy) return null
  return (
    <p className="dim" role="status">
      <Loader2 size={15} className="spin" aria-hidden="true" /> {a.busy}…
    </p>
  )
}

function SignOutLink({ label = 'Use a different account' }: { label?: string }) {
  const a = useAccess()
  return (
    <button type="button" className="linklike" onClick={() => void a.signOut()} disabled={!!a.busy}>
      <LogOut size={14} aria-hidden="true" /> {label}
    </button>
  )
}

/* ------------------------------------------------------------------ */

function SignIn() {
  const a = useAccess()
  const blocked = !!a.busy
  return (
    <div className="stack">
      <h2>Sign in</h2>
      <p className="dim">No real email, password or passcode required, just click on sign in.</p>
      <button className="btn btn-block" type="button" onClick={() => void a.signInDemo()} disabled={blocked}>
        Sign in
      </button>
      <Working />
      <Notice />
      <p className="fine">Offline simulation only. No external account or service is contacted.</p>
    </div>
  )
}

/** Appareil neuf: le compte doit l'approuver par le lien reçu par e-mail. La page se met à jour toute seule. */
function ApproveDevice() {
  const a = useAccess()
  const [link, setLink] = useState('')
  const [hint, setHint] = useState<string | null>(null)

  async function pasteAndApprove() {
    setHint(null)
    let text = ''
    try {
      text = (await navigator.clipboard.readText()).trim()
    } catch {
      setHint('This browser did not let us read the clipboard. Paste the link in the box below.')
      return
    }
    if (!text) {
      setHint('Nothing is copied yet. In the email, press and hold the link, then choose Copy.')
      return
    }
    await a.approveFromLink(text)
  }

  return (
    <div className="stack">
      <h2>Approve this device</h2>
      <p className="dim">
        This is a new device for your account. We sent an approval email to <b>{a.email}</b>.
      </p>
      <ol className="steps">
        <li>
          <b>Open the email</b> on this device.
        </li>
        <li>
          <b>Tap the approval link.</b> It must open in this browser, then this page continues by itself.
        </li>
        <li>
          <b>The link opened in another app?</b> Copy it, then tap <b>Paste approval link</b> below.
        </li>
      </ol>
      {a.approvalFailed && (
        <p className="hint" role="alert">
          This link has expired or was already used. Use “Get a new approval email” below.
        </p>
      )}
      <div className="stack">
        <button className="btn btn-block" onClick={() => void pasteAndApprove()} disabled={!!a.busy}>
          Paste approval link
        </button>
        <button className="btn ghost btn-block" onClick={() => void a.refresh()} disabled={!!a.busy}>
          I already tapped the link
        </button>
      </div>
      {hint && (
        <p className="hint" role="status">
          {hint}
        </p>
      )}
      <details className="manual">
        <summary>Paste the link by hand</summary>
        <Field label="Approval link">
          <input name="approval-link" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
        </Field>
        <button className="btn ghost btn-block" disabled={!link.trim() || !!a.busy} onClick={() => void a.approveFromLink(link.trim())}>
          Approve with this link
        </button>
      </details>
      <Working />
      <Notice />
      <SignOutLink label="Get a new approval email" />
    </div>
  )
}

function LegacyAccount() {
  return (
    <div className="stack">
      <h2>This account cannot be opened here</h2>
      <p className="dim">
        It still holds a passkey that an earlier version of this prototype registered with the wallet service. Passkeys are now managed by the local demo, so that one
        can no longer be used. Sign out to return to the local demo.
      </p>
      <Notice />
      <SignOutLink />
    </div>
  )
}

function Onboarding() {
  return (
    <div className="stack">
      <h2>One more step</h2>
      <p className="dim">The wallet service needs one more verification before it opens this wallet. Sign out and sign in again to continue.</p>
      <Notice />
      <SignOutLink />
    </div>
  )
}

function ExistingAccountNotice() {
  return (
    <div className="stack">
      <h2>Demo sign-in only</h2>
      <p className="dim">This prototype opens its local demo account without credentials. Sign out to return to demo sign-in.</p>
      <SignOutLink label="Return to demo sign-in" />
      <Notice />
    </div>
  )
}

export function AccessScreens() {
  const a = useAccess()
  const screen = {
    signed_out: <SignIn />,
    device_approval: <ApproveDevice />,
    mfa_required: <LegacyAccount />,
    onboarding: <Onboarding />,
    no_wallet: <ExistingAccountNotice />,
    locked: <ExistingAccountNotice />,
    ready: null,
  }[a.snapshot.state]
  return <Frame>{screen}</Frame>
}
