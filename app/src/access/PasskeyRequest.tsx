import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Hourglass } from 'lucide-react'
import { useAccess } from './AccessProvider'

/* Demandes d'ajout de passkey qui attendent leur délai de sécurité, sur cet appareil ou sur un autre. */

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`
}

/**
 * `canContinue`: on peut terminer la demande ici, une fois le délai passé. Sinon on ne propose que de l'annuler
 * (« ce n'était pas moi »). Le mot de passe, s'il est réclamé, est demandé dans une fenêtre dédiée.
 */
export function PendingRequests({ canContinue }: { canContinue: boolean }) {
  const a = useAccess()
  const now = useNow()
  const list = a.pendingRequests.filter((r) => r.scope === 'passkey:enroll')
  if (list.length === 0) return null
  const blocked = !!a.busy
  return (
    <ul className="stack pending" aria-live="polite">
      {list.map((r) => {
        const left = Math.max(0, Math.ceil((r.readyAt - now) / 1000))
        return (
          <li key={r.id} className="panel stack pending-item">
            <b className="pending-title">
              <Hourglass size={16} aria-hidden="true" /> A new passkey is waiting
            </b>
            <p className="dim">
              {left > 0 ? (
                <>
                  It can be added in <b className="num">{formatWait(left)}</b>.
                </>
              ) : (
                'The security delay is over.'
              )}{' '}
              Any device where you are signed in can cancel it.
            </p>
            <div className="row gap wrap">
              {canContinue && (
                <button className="btn" disabled={left > 0 || blocked} onClick={() => void a.addPasskey({ proof: false })}>
                  <Check size={15} aria-hidden="true" /> Add it to this device
                </button>
              )}
              <button className="btn ghost" disabled={blocked} onClick={() => void a.cancelRequest(r.id)}>
                <AlertTriangle size={15} aria-hidden="true" /> {canContinue ? 'Cancel it' : 'This was not me, cancel it'}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
