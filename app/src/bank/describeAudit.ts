import { short } from '../util'
import type { AuditEntry } from './api'

/* Texte lisible pour une entrée du journal d'audit de la banque. Le journal garde les faits; l'affichage les raconte. */

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const transfer = (d: Record<string, unknown>) => `${text(d.amount) || String(d.amount ?? '')} ${text(d.chain)} to ${short(text(d.to))}`
const reasons = (d: Record<string, unknown>) => (Array.isArray(d.reasons) ? d.reasons.map(String).join('; ') : '')

export function describeAudit(e: AuditEntry): { title: string; detail: string } {
  const d = e.detail
  switch (e.action) {
    case 'account.created':
      return { title: 'Account created', detail: '' }
    case 'session.signin':
      return { title: 'Signed in', detail: '' }
    case 'session.signout':
      return { title: 'Signed out', detail: '' }
    case 'session.failed':
      return { title: 'Failed sign-in attempt', detail: 'Wrong password' }
    case 'reauth.failed':
      return { title: 'Password check failed', detail: 'Asked again before a sensitive step' }
    case 'wallet.login_token':
      return { title: 'Wallet session opened', detail: 'The bank vouched for you with the wallet provider' }
    case 'passkey.authorized':
      return { title: 'Passkey authorized by the bank', detail: d.first ? 'First passkey, no delay' : 'After the security delay' }
    case 'passkey.registered':
      return { title: 'Passkey registered', detail: 'The wallet service confirmed it' }
    case 'passkey.authorization_requested':
      return { title: 'New passkey requested', detail: 'Waiting for the security delay' }
    case 'passkey.authorization_cancelled':
      return { title: 'Passkey request cancelled', detail: '' }
    case 'rules.updated':
      return { title: 'Limits updated', detail: '' }
    case 'transfer.cleared':
      return { title: 'Transfer cleared', detail: transfer(d) }
    case 'transfer.refused':
      return { title: 'Transfer refused', detail: [transfer(d), reasons(d)].filter(Boolean).join(' · ') }
    case 'transfer.simulated':
      return { title: 'Transfer simulated locally', detail: `${transfer(d)} · ${short(text(d.hash))}` }
    case 'transfer.failed':
      return { title: 'Transfer failed', detail: `${transfer(d)} · ${text(d.error)}` }
    default:
      return { title: e.action, detail: '' }
  }
}
