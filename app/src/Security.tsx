import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react'
import { copyText } from './util'
import { Field, Switch } from './Panels'
import { ErrorNote } from './Wallet'
import { CHAINS, CHAIN_META, formatAmount } from './chain/meta'
import { useChainData } from './chain/ChainProvider'
import { useAccess } from './access/AccessProvider'
import { removePasskeyGuarded } from './access/flows'
import { PendingRequests } from './access/PasskeyRequest'
import type { AuditEntry, AuditIntegrity, Policy } from './bank/api'
import { describeAudit } from './bank/describeAudit'
import type { Chain, DeviceInfo } from './provider/types'

type Notify = (msg: string) => void

const when = new Intl.DateTimeFormat('en-CH', { dateStyle: 'medium', timeStyle: 'short' })
const stamp = (iso: string | number) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : when.format(d)
}

/* ------------------------------------------------------------------ */
/* Wallets: local addresses and simulated balances                      */
/* ------------------------------------------------------------------ */

export function WalletsPanel({ notify }: { notify: Notify }) {
  const a = useAccess()
  const accounts = a.snapshot.accounts
  const { data, errors, loading, refresh } = useChainData()

  useEffect(() => a.clearError(), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row between wrap">
          <div>
            <h2>Your wallets</h2>
            <p className="dim">These are local simulation wallets. They are not real blockchain wallets and cannot receive real funds.</p>
          </div>
          <button className="btn ghost sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Refresh balances
          </button>
        </div>
        <div className="scroll-x">
          <table className="ledger cards">
            <thead>
              <tr>
                <th>Network</th>
                <th>Address</th>
                <th className="r">Balance</th>
              </tr>
            </thead>
            <tbody>
              {CHAINS.map((c) => {
                const acc = accounts.find((x) => x.chain === c)
                const info = data[c]
                return (
                  <tr key={c}>
                    <td data-label="Network">
                      <b>{CHAIN_META[c].network}</b>
                      <br />
                      <span className="dim">{CHAIN_META[c].testnet}</span>
                    </td>
                    <td data-label="Address">
                      {acc ? (
                        <div className="row gap addr-row">
                          <code className="addr-text">{acc.address}</code>
                          <button className="icon" aria-label={`Copy the ${CHAIN_META[c].network} address`} onClick={async () => notify((await copyText(acc.address)) ? 'Address copied' : 'Copy was blocked by the browser')}>
                            <Copy size={15} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <span className="dim">Not created</span>
                      )}
                    </td>
                    <td data-label="Balance" className="r num">
                      {info ? `${formatAmount(info.balance, c)} ${CHAIN_META[c].unit}` : errors[c] ? <span className="dim">Unavailable</span> : '…'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ErrorNote />
      </div>

      <div className="panel stack">
        <h2>Offline simulation</h2>
        <p className="dim">These balances, addresses and transfers are local demo data. The app does not create private keys, sign transactions, or connect to a blockchain.</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sécurité: passkeys et appareils                                     */
/* ------------------------------------------------------------------ */

/**
 * Trois situations, un seul bouton: le texte explique ce qui va se passer.
 *  - aucun passkey sur le compte: le premier est ajouté tout de suite;
 *  - cet appareil a déjà un passkey: un second est ajouté tout de suite, prouvé par le premier;
 *  - le compte a des passkeys, mais aucun sur cet appareil: c'est une récupération, avec le délai de sécurité de la banque.
 */
const PASSKEY_COPY = {
  first: {
    title: 'Add your first passkey',
    text: 'It signs you in without a password and approves each transfer. It is added straight away.',
    button: 'Add a passkey',
  },
  second: {
    title: 'Add a second passkey',
    text: 'This device already has a passkey, so the new one is added straight away. A second device protects you if you lose this phone.',
    button: 'Add a second passkey',
  },
  recover: {
    title: 'Add a passkey to this device',
    text: 'Your account has passkeys, but none on this device. The local demo waits through a security delay before it accepts a new one.',
    button: 'Add a passkey to this device',
  },
} as const

export function SecurityPanel({ notify }: { notify: Notify }) {
  const a = useAccess()
  const passkeys = a.passkeys
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = useCallback(async () => {
    try {
      setDevices(await a.wallet.listDevices())
    } catch {
      setDevices([])
    }
    await a.refreshPasskeys()
  }, [a.wallet, a.refreshPasskeys]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    a.clearError()
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = !!a.busy
  const count = passkeys?.length ?? 0
  const here = passkeys ? passkeys.filter((p) => a.passkeyIdsHere.includes(p.id)).length : 0
  const mode: keyof typeof PASSKEY_COPY | null = passkeys === null ? null : count === 0 ? 'first' : here > 0 ? 'second' : 'recover'

  async function addPasskey() {
    if (!mode) return
    const r = await a.addPasskey({ proof: mode === 'second' })
    if (r?.status === 'registered') {
      notify('Passkey added')
      await load()
    } else if (r?.status === 'pending') {
      notify('The local demo is holding the request for its security delay')
    }
  }
  async function removePasskey(id: string) {
    if (await a.act('Removing a passkey', () => removePasskeyGuarded({ wallet: a.wallet, bank: a.bank, authenticator: a.authenticator }, id))) {
      notify('Passkey removed')
      await load()
    }
  }
  async function revoke(id: string) {
    if (await a.act('Revoking a device', () => a.wallet.revokeDevice(id))) {
      notify('Device revoked')
      await load()
    }
  }
  async function revokeAll() {
    if (await a.act('Revoking all devices', () => a.wallet.revokeAllDevices())) {
      notify('All devices revoked')
      setConfirmAll(false)
      await load()
    }
  }

  return (
    <div className="cols">
      <div className="stack">
        <div className="panel stack">
          <h2>Passkeys</h2>
          {passkeys === null ? (
            <p className="dim">Loading…</p>
          ) : (
            <>
              {count < 2 && (
                <ul className="checks" aria-live="polite">
                  <li className="warn">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>
                      {count === 0 ? 'You have no passkey. Add one so your account is protected.' : 'You have a single passkey. Add a second one on another device so a lost phone does not lock you out.'}
                    </span>
                  </li>
                </ul>
              )}
              <ul className="sessions">
                {passkeys.map((p) => {
                  const onThisDevice = a.passkeyIdsHere.includes(p.id)
                  return (
                    <li key={p.id} className="passkey-row">
                      <span className="grow">
                        <b>{p.label}</b>
                        <br />
                        <span className="dim">
                          Added {stamp(p.createdAt)} · {p.synced ? 'synced between your devices' : 'on this device only'}
                        </span>
                      </span>
                      {onThisDevice && <span className="pill info">This device</span>}
                      <button
                        className="btn ghost sm"
                        onClick={() => void removePasskey(p.id)}
                        disabled={blocked || count < 2 || here === 0}
                        title={count < 2 ? 'Keep at least one passkey' : here === 0 ? 'Removing a passkey needs one on this device' : undefined}
                      >
                        Remove
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          <PendingRequests canContinue />
          {mode && (
            <div className="next-step stack">
              <b>{PASSKEY_COPY[mode].title}</b>
              <p className="dim">{PASSKEY_COPY[mode].text}</p>
              <button className="btn btn-block" onClick={() => void addPasskey()} disabled={blocked}>
                <KeyRound size={16} aria-hidden="true" /> {PASSKEY_COPY[mode].button}
              </button>
            </div>
          )}
          <p className="fine">The local demo stores passkey public credentials. The private part stays with your browser or device authenticator.</p>
        </div>

        <div className="panel stack">
          <h2>Registered devices</h2>
          {devices === null ? (
            <p className="dim">Loading…</p>
          ) : (
            <ul className="sessions">
              {devices.map((d) => (
                <li key={d.id} className="passkey-row">
                  <span className="grow">
                    <Smartphone size={15} aria-hidden="true" /> <b>{d.label}</b>
                    <br />
                    <span className="dim">Since {stamp(d.createdAt)}</span>
                  </span>
                  {d.current ? (
                    <span className="pill ok">This device</span>
                  ) : (
                    <button className="btn ghost sm" onClick={() => void revoke(d.id)} disabled={blocked}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorNote />
      </div>

      <div className="stack">
        <div className="panel stack">
          <h2>Lost a device?</h2>
          <p className="dim">
            Revoking all devices means each one must be approved again by email before it can open your wallet. Your wallets and addresses stay the same.
          </p>
          {!confirmAll ? (
            <button className="btn ghost" onClick={() => setConfirmAll(true)} disabled={blocked}>
              Revoke all devices
            </button>
          ) : (
            <div className="stack">
              <ul className="checks" aria-live="polite">
                <li className="warn">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>Every device will need a new approval, possibly including this one. Continue?</span>
                </li>
              </ul>
              <div className="actions">
                <button className="btn" onClick={() => void revokeAll()} disabled={blocked}>
                  Yes, revoke all devices
                </button>
                <button className="btn ghost" onClick={() => setConfirmAll(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Récupération                                                        */
/* ------------------------------------------------------------------ */

const RECOVERY_STEPS = [
  ['Sign in to this local demo', 'Use the test account and password created for the local service.'],
  ['Unlock this browser wallet', 'Enter the passcode that was used when the local demo wallet was created.'],
  ['Keep a local copy of your data', 'The demo wallet is stored in this browser and does not sync to another device.'],
] as const

export function RecoveryPanel() {
  const a = useAccess()
  const n = a.passkeys ? a.passkeys.length : null
  return (
    <div className="cols">
      <div className="stack">
        <div className="panel stack">
          <h2>Are you ready for a lost phone?</h2>
          <ul className="checks" aria-live="polite">
            {n === null ? (
              <li className="bad">
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>Checking your passkeys…</span>
              </li>
            ) : n >= 2 ? (
              <li className="ok">
                <Check size={16} aria-hidden="true" />
                <span>{n} passkeys registered, on different devices.</span>
              </li>
            ) : (
              <li className="warn">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{n === 0 ? 'No passkey registered.' : 'One passkey only.'} Add another one in Security.</span>
              </li>
            )}
            <li className="ok">
              <Check size={16} aria-hidden="true" />
              <span>This demo does not send email or approval links.</span>
            </li>
            <li className="warn">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>Your passcode cannot be shown or reset. Store it somewhere safe, away from your phone.</span>
            </li>
          </ul>
        </div>
        <div className="panel stack">
          <h2>Recover on a new device</h2>
          <ol className="timeline">
            {RECOVERY_STEPS.map(([title, text], i) => (
              <li key={title} className="now">
                <span className="tick">{i + 1}</span>
                <span>
                  <b>{title}</b>
                  <br />
                  <span className="dim">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="stack">
        <div className="panel stack">
          <h2>What the local demo simulates</h2>
          <ul className="checks">
            <li className="ok">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>Verify a local test account and manage passkeys stored by the local service.</span>
            </li>
            <li className="ok">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>Apply transfer limits and approved-address rules to simulated transfers.</span>
            </li>
            <li className="bad">
              <X size={16} aria-hidden="true" />
              <span>Sign or broadcast real blockchain transactions.</span>
            </li>
            <li className="bad">
              <X size={16} aria-hidden="true" />
              <span>Read or reset the passcode stored only in this browser.</span>
            </li>
          </ul>
        </div>
        <div className="panel stack">
          <h2>If you lose your passcode</h2>
          <p className="dim">Your wallet cannot be recovered by anyone. This is the price of keeping full control of your assets.</p>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Règles de la banque et journal d'audit                              */
/* ------------------------------------------------------------------ */

type Draft = { perTx: Record<Chain, string>; perDay: Record<Chain, string>; list: Record<Chain, string>; blockUnknown: boolean }

const toDraft = (p: Policy): Draft => ({
  perTx: Object.fromEntries(CHAINS.map((c) => [c, String(p.maxPerTx[c])])) as Draft['perTx'],
  perDay: Object.fromEntries(CHAINS.map((c) => [c, String(p.maxPerDay[c])])) as Draft['perDay'],
  list: Object.fromEntries(CHAINS.map((c) => [c, p.allowlist[c].join('\n')])) as Draft['list'],
  blockUnknown: p.blockUnknownDestinations,
})

const isAmount = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0

export function BankRules({ notify }: { notify: Notify }) {
  const a = useAccess()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [audit, setAudit] = useState<{ entries: AuditEntry[]; integrity: AuditIntegrity } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [policy, log] = await Promise.all([a.bank.policy(), a.bank.audit()])
      setDraft(toDraft(policy))
      setAudit(log)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'The bank could not be reached.')
    }
  }, [a.bank])
  useEffect(() => {
    a.clearError()
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const bad = draft ? CHAINS.filter((c) => !isAmount(draft.perTx[c]) || !isAmount(draft.perDay[c])) : []

  async function save() {
    if (!draft || bad.length) return
    const next: Policy = {
      maxPerTx: Object.fromEntries(CHAINS.map((c) => [c, Number(draft.perTx[c])])) as Policy['maxPerTx'],
      maxPerDay: Object.fromEntries(CHAINS.map((c) => [c, Number(draft.perDay[c])])) as Policy['maxPerDay'],
      allowlist: Object.fromEntries(CHAINS.map((c) => [c, draft.list[c].split('\n').map((s) => s.trim()).filter(Boolean)])) as Policy['allowlist'],
      blockUnknownDestinations: draft.blockUnknown,
    }
    const out: { saved?: Policy } = {}
    if (await a.act('Saving your rules', async () => void (out.saved = await a.bank.savePolicy(next)))) {
      if (out.saved) setDraft(toDraft(out.saved))
      notify('Rules saved by the bank')
      await load()
    }
  }

  if (loadError) {
    return (
      <div className="panel stack">
        <h2>Your limits</h2>
        <p className="hint" role="alert">
          {loadError}
        </p>
        <button className="btn ghost fit" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }
  if (!draft) {
    return (
      <div className="panel stack">
        <p className="dim">Loading your rules from the bank…</p>
      </div>
    )
  }

  return (
    <div className="cols">
      <div className="panel stack">
        <h2>Your limits</h2>
        <p className="dim">The local demo checks each simulated transfer against these rules. No real transaction is signed or broadcast.</p>
        {CHAINS.map((c) => (
          <div key={c} className="stack">
            <div className="grid2">
              <Field label={`Per transfer, ${CHAIN_META[c].unit}`}>
                <input inputMode="decimal" name={`limit-${c}`} autoComplete="off" value={draft.perTx[c]} onChange={(e) => setDraft({ ...draft, perTx: { ...draft.perTx, [c]: e.target.value } })} aria-invalid={!isAmount(draft.perTx[c])} />
              </Field>
              <Field label={`Per 24 hours, ${CHAIN_META[c].unit}`}>
                <input inputMode="decimal" name={`daily-${c}`} autoComplete="off" value={draft.perDay[c]} onChange={(e) => setDraft({ ...draft, perDay: { ...draft.perDay, [c]: e.target.value } })} aria-invalid={!isAmount(draft.perDay[c])} />
              </Field>
            </div>
            <Field label={`Approved ${CHAIN_META[c].network} addresses (one per line)`}>
              <textarea rows={2} name={`allow-${c}`} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.list[c]} onChange={(e) => setDraft({ ...draft, list: { ...draft.list, [c]: e.target.value } })} />
            </Field>
          </div>
        ))}
        <Switch on={draft.blockUnknown} onChange={(v) => setDraft({ ...draft, blockUnknown: v })} label="Only send to approved addresses" hint="Refuse any address that is not on your list." />
        {bad.length > 0 && <p className="hint">Enter a number of zero or more for every limit.</p>}
        <ErrorNote />
        <div className="actions">
          <button className="btn" onClick={() => void save()} disabled={bad.length > 0 || !!a.busy}>
            Save rules
          </button>
        </div>
      </div>

      <div className="panel stack">
        <div className="row between">
          <h2>Audit trail</h2>
          <button className="btn ghost sm" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
        {audit && (
          <p className={`pill ${audit.integrity.ok ? 'ok' : 'bad'} fit`} role="status">
            {audit.integrity.ok ? `Chain verified · ${audit.integrity.count} entries` : `Tampering detected at entry #${audit.integrity.brokenAtSeq}`}
          </p>
        )}
        <p className="dim">Kept by the bank. Each entry contains the fingerprint of the previous one, so editing or deleting a line breaks the chain and is detected.</p>
        {!audit || audit.entries.length === 0 ? (
          <p className="empty">Nothing yet. Security events and transfer checks appear here.</p>
        ) : (
          <div className="scroll-x">
            <table className="ledger cards">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {audit.entries.slice(0, 40).map((e) => {
                  const d = describeAudit(e)
                  return (
                    <tr key={e.seq}>
                      <td data-label="When" className="num">
                        {stamp(e.at)}
                      </td>
                      <td data-label="Event">
                        <b>{d.title}</b>
                        {d.detail && (
                          <>
                            <br />
                            <span className="dim">{d.detail}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
