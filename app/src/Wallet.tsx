import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { AlertTriangle, Check, Copy, Fingerprint, Loader2, RefreshCw, Share2, X } from 'lucide-react'
import { copyText, parseAmount, shareOrCopy, short, validateAddress } from './util'
import { Field } from './Panels'
import { useAccess } from './access/AccessProvider'
import { type TransferVerdict } from './bank/api'
import { CHAINS, CHAIN_META, formatAmount } from './chain/meta'
import { useChainData } from './chain/ChainProvider'
import type { Chain } from './provider/types'

type Notify = (msg: string) => void

function RuleCheck({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? 'ok' : 'bad'}>
      {ok ? <Check size={14} /> : <AlertTriangle size={14} />}
      {children}
    </li>
  )
}

/** Copier + partager, pour une adresse ou un reçu. Les deux exigent une valeur non vide. */
export function CopyShare({ value, title, what, notify, disabled }: { value: string; title: string; what: string; notify: Notify; disabled?: boolean }) {
  const off = disabled || !value
  return (
    <div className="row gap">
      <button type="button" className="btn ghost" disabled={off} onClick={async () => notify((await copyText(value)) ? `${what} copied` : 'Copy was blocked by the browser')}>
        <Copy size={15} /> Copy
      </button>
      <button
        type="button"
        className="btn ghost"
        disabled={off}
        onClick={async () => {
          const r = await shareOrCopy(title, value)
          if (r === 'shared') notify(`${what} shared`)
          if (r === 'copied') notify(`Sharing isn't available here, so the ${what.toLowerCase()} was copied`)
          if (r === 'failed') notify('Share was blocked by the browser')
        }}
      >
        <Share2 size={15} /> Share
      </button>
    </div>
  )
}

/** Erreur de la dernière action (refus de la banque, passkey annulé, réseau...). */
export function ErrorNote() {
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

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

type Sent = { hash: string; chain: Chain; amount: string; to: string }

const DEMO_RECIPIENTS: Record<Chain, string> = {
  BTC: 'tb1q9rp4v3rlw47zyzargsfmx6edtrg030adng3rh4',
  EVM: '0x6DB8A8CDE4fF95d95570589D850136D2B0932b1D',
  SOL: 'EWdbpPpotPtJrvBms5j4cVQouo7iR5DVvJjCVL99pAWX',
}

export function SendPanel({ notify }: { notify: Notify }) {
  const a = useAccess()
  const { data, errors, refresh } = useChainData()
  const [chain, setChain] = useState<Chain>('BTC')
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<'form' | 'review' | 'done'>('form')
  const [verdict, setVerdict] = useState<TransferVerdict | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)

  const meta = CHAIN_META[chain]
  const exact = parseAmount(amount)
  const balance = data[chain]?.balance
  const fee = data[chain]?.estimatedFee ?? 0
  const recipient = DEMO_RECIPIENTS[chain]
  const addrOk = validateAddress(chain, recipient)
  const fundsOk = exact !== null && balance !== undefined && Number(exact) + fee <= balance + 1e-12
  const canAsk = addrOk && fundsOk && !a.busy
  const locked = step !== 'form' || !!a.busy
  const expired = !!verdict?.expiresAt && Date.now() > verdict.expiresAt
  const edited = () => {
    setVerdict(null)
    setStep('form')
  }

  const addrMsg = `Recipient address is fixed for this offline prototype.`

  /** La banque regarde le transfert avant que le client ne signe. Elle peut refuser, jamais initier ni signer. */
  async function askBank() {
    if (exact === null) return
    const out: { v?: TransferVerdict } = {}
    const ok = await a.act('Asking the bank', async () => {
      out.v = await a.bank.checkTransfer({ chain, to: recipient, amount: Number(exact) })
    })
    if (!ok || !out.v) return
    setVerdict(out.v)
    setStep(out.v.allowed ? 'review' : 'form')
  }

  /** Autorisation de signer par la banque (passkey du client, lié à ce transfert), puis signature MPC (la part du client et celle du fournisseur), puis diffusion. La banque est informée du résultat. */
  async function confirm() {
    if (exact === null || !verdict?.authorizationId) return
    const authorizationId = verdict.authorizationId
    const out: { hash?: string; unrecorded?: boolean } = {}
    const ok = await a.act('Signing', async () => {
      // Un passkey refusé n'engage rien: la décision de la banque reste valable et le client peut réessayer.
      await a.authorize({ authorizationId })
      try {
        out.hash = (await a.wallet.sendNative(chain, recipient, exact)).hash
      } catch (e) {
        await a.bank.reportTransfer({ authorizationId, error: e instanceof Error ? e.message : 'failed' }).catch(() => undefined)
        throw e
      }
      await a.bank.reportTransfer({ authorizationId, hash: out.hash, from: a.snapshot.accounts.find((account) => account.chain === chain)?.address }).catch(() => (out.unrecorded = true))
    })
    if (!ok || !out.hash) return
    setSent({ hash: out.hash, chain, amount: exact, to: recipient })
    setStep('done')
    if (out.unrecorded) notify('Sent, but the bank could not record it')
    window.setTimeout(() => void refresh(), 4000)
  }

  function again() {
    setAmount('')
    setSent(null)
    setVerdict(null)
    setStep('form')
  }

  if (step === 'done' && sent) {
    const m = CHAIN_META[sent.chain]
    const receipt = `equinox local simulation\n${sent.amount} ${m.unit} on ${m.testnet}\nTo: ${sent.to}\nSimulation ID: ${sent.hash}`
    return (
      <div className="panel narrow stack">
        <div className="done-mark">
          <Check size={22} aria-hidden="true" />
        </div>
        <h2>Transfer simulated</h2>
        <p className="dim">
          No blockchain transaction was signed or broadcast. This transfer was recorded only in the local simulation.
        </p>
        <dl className="review">
          <dt>Amount</dt>
          <dd className="num">
            {sent.amount} {m.unit}
          </dd>
          <dt>To</dt>
          <dd>
            <code>{sent.to}</code>
          </dd>
          <dt>Simulation ID</dt>
          <dd>
            <code>{sent.hash}</code>
          </dd>
        </dl>
        <div className="row gap wrap">
          <CopyShare value={receipt} title="Transfer receipt" what="Receipt" notify={notify} />
          <button className="btn" onClick={again}>
            Send another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cols">
      <div className="panel stack">
        <h2>Send</h2>
        <p className="dim">Offline simulation only. No real funds, signatures or network transfers are involved.</p>

        <div className="grid2">
          <Field label="Network">
            <select
              name="network"
              value={chain}
              onChange={(e) => {
                setChain(e.target.value as Chain)
                edited()
              }}
              disabled={locked}
            >
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_META[c].network} · {data[c] ? `${formatAmount(data[c]!.balance, c)} ${CHAIN_META[c].unit} available` : errors[c] ? 'balance unavailable' : 'reading balance…'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Test network">
            <div className="static">
              <span className="tag">{meta.testnet}</span>
            </div>
          </Field>
        </div>

        <Field label="Recipient address (required)">
          <input
            name="recipient"
            autoComplete="off"
            value={recipient}
            disabled
            spellCheck={false}
            aria-invalid={!addrOk}
          />
        </Field>
        <p className={`msg ${addrOk ? 'ok' : 'bad'}`}>{addrMsg}</p>

        <Field label={`Amount in ${meta.unit}`}>
          <div className="pw">
            <input
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                edited()
              }}
              disabled={locked}
              placeholder="0.00"
              aria-invalid={!!amount && exact === null}
            />
            <button
              type="button"
              className="maxbtn"
              disabled={locked || balance === undefined}
              onClick={() => {
                setAmount(formatAmount(Math.max(0, (balance ?? 0) - fee * 1.2), chain))
                edited()
              }}
            >
              Max
            </button>
          </div>
        </Field>
        {amount && exact === null && <p className="hint">Enter a number greater than zero, with at most 18 decimals.</p>}

        {step === 'form' && (
          <button className="btn" disabled={!canAsk} onClick={() => void askBank()}>
            Ask the bank to check this transfer
          </button>
        )}

        {verdict && !verdict.allowed && (
          <div className="lp-verdict-inline no" role="alert">
            <X size={18} aria-hidden="true" />
            <div>
              <strong>The bank refuses this transfer</strong>
              <p>{verdict.reasons.join('. ')}.</p>
              <p className="dim">Change the amount or the address, or update your limits in Profile, Bank rules.</p>
            </div>
          </div>
        )}

        <AnimatePresence>
          {step === 'review' && verdict?.allowed && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="review-box">
              <dl className="review">
                <dt>You send</dt>
                <dd className="num">
                  {exact} {meta.unit}
                </dd>
                <dt>To</dt>
                <dd>
                  <code>{short(recipient)}</code>
                </dd>
                <dt>Network fee</dt>
                <dd className="num">about {formatAmount(fee, chain)} {meta.unit}</dd>
                <dt>Bank check</dt>
                <dd>{expired ? 'Expired, check again' : 'Cleared'}</dd>
              </dl>
              <p className="dim">Your passkey confirms this transfer. Check the address one last time: a crypto transfer cannot be undone.</p>
              <div className="row gap">
                <button className="btn" onClick={() => void confirm()} disabled={!!a.busy || expired}>
                  {a.busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Fingerprint size={16} aria-hidden="true" />}
                  {a.busy ? `${a.busy}…` : 'Confirm with passkey and send'}
                </button>
                <button className="btn ghost" onClick={edited} disabled={!!a.busy}>
                  Edit
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorNote />
      </div>

      <div className="panel stack">
        <h2>Before it goes out</h2>
        <ul className="checks">
          <RuleCheck ok={addrOk}>{addrOk ? `Address has the ${meta.network} test-network form` : `Enter a ${meta.network} test-network address`}</RuleCheck>
          <RuleCheck ok={fundsOk}>
            {exact === null
              ? 'Enter an amount'
              : balance === undefined
                ? 'Reading your balance…'
                : fundsOk
                  ? 'Balance covers the amount and the estimated fee'
                  : 'Amount plus estimated fee is more than your balance'}
          </RuleCheck>
          <RuleCheck ok={!verdict || verdict.allowed}>
            {!verdict ? 'The bank checks your limits and approved-address rules when you ask' : verdict.allowed ? 'Cleared by the bank' : `Refused by the bank: ${verdict.reasons.join('. ')}`}
          </RuleCheck>
        </ul>
        <p className="dim">
          The bank can refuse a transfer. It cannot start one or sign it. Crypto transfers cannot be undone, so send a small test amount first when the address is new.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Receive                                                             */
/* ------------------------------------------------------------------ */

export function ReceivePanel({ notify, initial = 'BTC' }: { notify: Notify; initial?: Chain }) {
  const a = useAccess()
  const { data, errors, loading, refresh } = useChainData()
  const [chain, setChain] = useState<Chain>(initial)
  const meta = CHAIN_META[chain]
  const address = a.snapshot.accounts.find((x) => x.chain === chain)?.address ?? ''
  const info = data[chain]

  return (
    <div className="panel narrow stack">
      <h2>Receive</h2>
      <div className="chips" role="group" aria-label="Network">
        {CHAINS.map((c) => (
          <button key={c} className={`chip ${chain === c ? 'on' : ''}`} onClick={() => setChain(c)} aria-pressed={chain === c}>
            {CHAIN_META[c].network}
          </button>
        ))}
      </div>

      {address ? (
        <div className="receive">
          <AnimatePresence mode="wait">
            <motion.div key={chain} className="qr" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <QRCodeSVG value={address} size={188} bgColor="#ffffff" fgColor="#323232" level="M" marginSize={2} title={`${meta.network} address QR code`} />
            </motion.div>
          </AnimatePresence>
          <div className="stack grow">
            <div>
              <span className="dim">Your {meta.network} address</span>
              <div className="addr-box">
                <code>{address}</code>
              </div>
            </div>
            <CopyShare value={address} title={`My ${meta.network} address`} what="Address" notify={notify} />
            <div className="row gap wrap">
              <span className="num">
                {info ? `${formatAmount(info.balance, chain)} ${meta.unit}` : errors[chain] ? 'Balance unavailable' : 'Reading balance…'}
              </span>
              <button className="btn ghost sm" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Refresh
              </button>
            </div>
            {errors[chain] && <p className="hint">{errors[chain]}</p>}
            <p className="dim">This simulated address is local to this browser. Do not send funds to it.</p>
          </div>
        </div>
      ) : (
        <p className="empty">No {meta.network} wallet yet.</p>
      )}
    </div>
  )
}
