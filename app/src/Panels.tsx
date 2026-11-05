import { useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Download, Loader2, RefreshCw, Search } from 'lucide-react'
import { dateTime, short } from './util'
import { CHAINS, CHAIN_META, formatAmount } from './chain/meta'
import { useChainData } from './chain/ChainProvider'
import type { ChainTx } from './bank/api'
import type { Chain } from './provider/types'

type Notify = (msg: string) => void

export type ActivityRow = ChainTx & { chain: Chain }

/** Toutes les transactions des trois réseaux, la plus récente d'abord (les non confirmées en tête). */
export function useActivity(): { rows: ActivityRow[]; stale: Chain[] } {
  const { data, errors } = useChainData()
  return useMemo(() => {
    const rows = CHAINS.flatMap((c) => (data[c]?.txs ?? []).map((t): ActivityRow => ({ ...t, chain: c })))
    rows.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity))
    return { rows, stale: CHAINS.filter((c) => errors[c]) }
  }, [data, errors])
}

export const DIRECTION_LABEL = { in: 'Received', out: 'Sent', self: 'To yourself' } as const

export function statusOf(r: ChainTx): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!r.ok) return { label: 'Failed', tone: 'bad' }
  return r.confirmed ? { label: 'Confirmed', tone: 'ok' } : { label: 'Pending', tone: 'warn' }
}

/* ------------------------------------------------------------------ */
/* Local simulated transaction history                                 */
/* ------------------------------------------------------------------ */

export function History({ notify }: { notify: Notify }) {
  const { loading, refresh, errors } = useChainData()
  const { rows } = useActivity()
  const [network, setNetwork] = useState<'All' | Chain>('All')
  const [direction, setDirection] = useState<'All' | keyof typeof DIRECTION_LABEL>('All')
  const [q, setQ] = useState('')

  const shown = rows.filter(
    (r) =>
      (network === 'All' || r.chain === network) &&
      (direction === 'All' || r.direction === direction) &&
      (q === '' || `${r.hash} ${r.counterparty ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())),
  )

  function exportCsv() {
    const head = 'date,network,type,amount,unit,fee,counterparty,status,hash'
    const body = shown.map((r) =>
      [
        r.time ? new Date(r.time).toISOString() : 'pending',
        CHAIN_META[r.chain].testnet,
        DIRECTION_LABEL[r.direction],
        r.amount,
        CHAIN_META[r.chain].unit,
        r.fee ?? '',
        r.counterparty ?? '',
        statusOf(r).label,
        r.hash,
      ].join(','),
    )
    const blob = new Blob([[head, ...body].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'equinox-transaction-history.csv'
    a.click()
    URL.revokeObjectURL(a.href)
    notify(`Exported ${shown.length} entries to CSV`)
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter by network">
          {(['All', ...CHAINS] as const).map((c) => (
            <button key={c} className={`chip ${network === c ? 'on' : ''}`} aria-pressed={network === c} onClick={() => setNetwork(c)}>
              {c === 'All' ? 'All networks' : CHAIN_META[c].network}
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Filter by type">
          {(['All', 'in', 'out', 'self'] as const).map((d) => (
            <button key={d} className={`chip ${direction === d ? 'on' : ''}`} aria-pressed={direction === d} onClick={() => setDirection(d)}>
              {d === 'All' ? 'All types' : DIRECTION_LABEL[d]}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={15} aria-hidden="true" />
          <input type="search" name="q" autoComplete="off" spellCheck={false} aria-label="Search transactions" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a hash or an address…" />
        </label>
        <button className="btn ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />} Refresh
        </button>
        <button className="btn ghost" onClick={exportCsv} disabled={shown.length === 0}>
          <Download size={15} aria-hidden="true" /> Export CSV
        </button>
      </div>

      {CHAINS.filter((c) => errors[c]).map((c) => (
        <p key={c} className="hint" role="status">
          {CHAIN_META[c].network}: {errors[c]}. The list below may be out of date for this network.
        </p>
      ))}

      <div className="panel flush">
        <div className="scroll-x">
          <table className="ledger cards">
            <thead>
              <tr>
                <th>Date</th>
                <th>Network</th>
                <th>Type</th>
                <th className="r">Amount</th>
                <th className="r">Fee</th>
                <th>Counterparty</th>
                <th>Status</th>
                <th><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const m = CHAIN_META[r.chain]
                const st = statusOf(r)
                return (
                  <tr key={`${r.chain}-${r.hash}`}>
                    <td data-label="Date" className="num dim">{r.time ? dateTime(r.time) : 'Pending'}</td>
                    <td data-label="Network">{m.network}</td>
                    <td data-label="Type">
                      <b>{DIRECTION_LABEL[r.direction]}</b>
                    </td>
                    <td data-label="Amount" className={`r num ${r.direction === 'in' ? 'pos' : r.direction === 'out' ? 'neg' : ''}`}>
                      {r.direction === 'in' ? '+' : r.direction === 'out' ? '-' : ''}
                      {formatAmount(r.amount, r.chain)} {m.unit}
                    </td>
                    <td data-label="Fee" className="r num dim">{r.fee != null ? `${formatAmount(r.fee, r.chain)} ${m.unit}` : ''}</td>
                    <td data-label="Counterparty">{r.counterparty ? <code title={r.counterparty}>{short(r.counterparty)}</code> : <span className="dim">-</span>}</td>
                    <td data-label="Status">
                      <span className={`pill ${st.tone}`}>{st.label}</span>
                    </td>
                    <td />
                  </tr>
                )
              })}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="empty pad">{rows.length === 0 ? 'No simulated transactions yet.' : 'No entries match. Clear the search or the filters.'}</p>
          )}
        </div>
      </div>
      <p className="dim">Transactions are simulated locally and are not broadcast to a blockchain.</p>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch" onClick={() => onChange(!on)}>
      <span className={`track ${on ? 'on' : ''}`}>
        <i />
      </span>
      <span className="grow">
        {label}
        {hint && (
          <>
            <br />
            <span className="dim">{hint}</span>
          </>
        )}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Shared: wordmark                                                    */
/* ------------------------------------------------------------------ */

export function Wordmark() {
  return (
    <div className="wordmark">
      <span>equinox</span>
      <svg viewBox="0 0 120 14" aria-hidden>
        <motion.path
          d="M2 9 C 20 2, 30 13, 48 7 S 80 2, 96 8 S 112 11, 118 5"
          fill="none"
          strokeWidth="2.2"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.6, ease: 'easeInOut' }}
        />
      </svg>
    </div>
  )
}
