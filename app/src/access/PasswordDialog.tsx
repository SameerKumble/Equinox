import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'

/* Demande du mot de passe de la banque pour une action sensible: une fenêtre claire, avec son bouton de validation.
   Le mot de passe n'est jamais affiché par défaut, et Échap ou « Annuler » ferment sans rien faire. */

export function PasswordDialog({
  reason,
  error,
  onConfirm,
  onCancel,
}: {
  reason: string
  error?: string
  onConfirm: (password: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function submit(e: FormEvent) {
    e.preventDefault()
    if (password) onConfirm(password)
  }

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <form className="dialog stack" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={submit}>
        <h2 id="password-title">Confirm it is you</h2>
        <p className="dim">{reason}</p>
        <div className="field">
          <label htmlFor="dialog-password">Local demo password</label>
          <div className="pw">
            <input
              id="dialog-password"
              ref={input}
              type={shown ? 'text' : 'password'}
              name="bank-password"
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? 'password-error' : undefined}
              className="has-toggle"
            />
            <button type="button" className="icon pw-toggle" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
              {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>
        {error && (
          <p id="password-error" className="hint" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={!password}>
            Confirm
          </button>
        </div>
      </form>
    </div>
  )
}
