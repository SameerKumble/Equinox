import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleUser,
  History as HistoryIcon,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Scale,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { dateTime, nameFromEmail, short } from './util'
import { DIRECTION_LABEL, History, statusOf, useActivity, Wordmark } from './Panels'
import { ReceivePanel, SendPanel, CopyShare } from './Wallet'
import { BankRules, RecoveryPanel, SecurityPanel, WalletsPanel } from './Security'
import { AccessProvider, useAccess, type Backend } from './access/AccessProvider'
import { PendingRequests } from './access/PasskeyRequest'
import { AccessScreens } from './access/screens'
import { ChainProvider, useChainData } from './chain/ChainProvider'
import { CHAINS, CHAIN_META, formatAmount } from './chain/meta'
import type { Chain } from './provider/types'

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'transfer', label: 'Send and receive', icon: ArrowLeftRight },
  { id: 'history', label: 'Transaction history', icon: HistoryIcon },
] as const
type TabId = (typeof NAV)[number]['id'] | 'settings'

const TRANSFER = [
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
] as const
type TransferTab = (typeof TRANSFER)[number]['id']

const PROFILE = [
  { id: 'wallets', label: 'Wallets', icon: Wallet },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'recovery', label: 'Recovery', icon: LifeBuoy },
  { id: 'rules', label: 'Bank rules and audit', icon: Scale },
] as const
type ProfileTab = (typeof PROFILE)[number]['id']

const TITLES: Record<TabId, string> = {
  overview: 'Overview',
  transfer: 'Send and receive',
  history: 'Transaction history',
  settings: 'Profile and settings',
}

/* ---------- overview ---------- */

function Overview({ setTab, goTransfer, notify }: { setTab: (t: TabId) => void; goTransfer: (t: TransferTab, chain?: Chain) => void; notify: (m: string) => void }) {
  const a = useAccess()
  const { data, errors, loading, refresh } = useChainData()
  const { rows } = useActivity()
  const accounts = a.snapshot.accounts
  const funded = CHAINS.some((c) => (data[c]?.balance ?? 0) > 0)
  const loaded = CHAINS.every((c) => data[c] || errors[c])
  const others = a.pendingRequests.filter((r) => r.scope === 'passkey:enroll')
  const passkeyCount = a.passkeys ? a.passkeys.length : null
  const needs = others.length > 0 || passkeyCount === 0 || passkeyCount === 1 || (loaded && !funded)

  return (
    <div className="stack">
      <div>
        <div className="row between gap">
          <h2>Your wallets</h2>
          <button className="btn ghost sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
        <p className="dim">Local simulation only. Wallets, balances and transfers stay on this device and are not connected to a blockchain.</p>
      </div>

      <div className="tiles">
        {CHAINS.map((c) => {
          const m = CHAIN_META[c]
          const acc = accounts.find((x) => x.chain === c)
          const info = data[c]
          return (
            <div key={c} className="panel tile stack">
              <div className="row between">
                <b>{m.network}</b>
                <span className="tag">{m.testnet}</span>
              </div>
              <div className="total num">
                {info ? formatAmount(info.balance, c) : errors[c] ? '-' : '…'} <span className="dim">{m.unit}</span>
              </div>
              {errors[c] && <p className="hint">{errors[c]}</p>}
              {acc && (
                <div className="row gap">
                  <code className="addr-text" title={acc.address}>
                    {short(acc.address)}
                  </code>
                </div>
              )}
              <div className="row gap wrap">
                <button className="btn ghost sm" onClick={() => goTransfer('receive', c)}>
                  <ArrowDownLeft size={14} aria-hidden="true" /> Receive
                </button>
                <button className="btn ghost sm" onClick={() => goTransfer('send', c)} disabled={!info || info.balance <= 0}>
                  <ArrowUpRight size={14} aria-hidden="true" /> Send
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="cols">
        <div className="panel stack">
          <h2>Needs your attention</h2>
          {!needs ? (
            <p className="empty">Nothing is waiting.</p>
          ) : (
            <ul className="attn">
              {others.length > 0 && (
                <li>
                  <span className="pill warn">Security</span>
                  <span>
                    <b>A new passkey was requested for your account.</b> <span className="dim">If it was not you, cancel it now.</span>
                  </span>
                </li>
              )}
              {passkeyCount === 1 && (
                <li>
                  <span className="pill info">Advice</span>
                  <span>
                    <b>You have a single passkey.</b> <span className="dim">Add a second one on another device so a lost phone does not lock you out.</span>
                  </span>
                  <button className="btn ghost sm" onClick={() => setTab('settings')}>
                    Open security
                  </button>
                </li>
              )}
              {loaded && !funded && (
                <li>
                  <span className="pill info">Start</span>
                  <span>
                    <b>Your wallets are empty.</b> <span className="dim">Get free test coins, then they show up here.</span>
                  </span>
                  <button className="btn ghost sm" onClick={() => goTransfer('receive')}>
                    Get an address
                  </button>
                </li>
              )}
            </ul>
          )}
          <PendingRequests canContinue={false} />
          <CopyShare value={accounts.map((x) => `${CHAIN_META[x.chain].network}: ${x.address}`).join('\n')} title="My addresses" what="Addresses" notify={notify} disabled={accounts.length === 0} />
        </div>

        <div className="panel stack">
          <h2>Latest activity</h2>
          {rows.length === 0 ? (
            <p className="empty">No transaction yet. Fund a wallet with test coins, or send one once it has a balance.</p>
          ) : (
            <ul className="attn">
              {rows.slice(0, 6).map((r) => (
                <li key={`${r.chain}-${r.hash}`}>
                  <span className="num dim">{r.time ? dateTime(r.time) : 'Pending'}</span>
                  <span>
                    <b>{DIRECTION_LABEL[r.direction]}</b> <span className="dim">{CHAIN_META[r.chain].network}</span>
                    {!r.ok && <span className="pill bad">Failed</span>}
                    {r.ok && !r.confirmed && <span className={`pill ${statusOf(r).tone}`}>Pending</span>}
                  </span>
                  <span className={`num ${r.direction === 'in' ? 'pos' : r.direction === 'out' ? 'neg' : ''}`}>
                    {r.direction === 'in' ? '+' : r.direction === 'out' ? '-' : ''}
                    {formatAmount(r.amount, r.chain)} {CHAIN_META[r.chain].unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button className="btn ghost fit" onClick={() => setTab('history')}>
            Open transaction history
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- send and receive ---------- */

/** Sur téléphone, les onglets défilent sur une ligne: l'onglet choisi se place entièrement à l'écran. */
function showTab(e: { currentTarget: HTMLElement }, select: () => void) {
  select()
  e.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

function Transfer({ tab, setTab, receiveChain, notify }: { tab: TransferTab; setTab: (t: TransferTab) => void; receiveChain: Chain; notify: (m: string) => void }) {
  return (
    <div className="stack">
      <div className="subtabs" role="tablist" aria-label="Send and receive sections">
        <div>
          {TRANSFER.map((s) => (
            <button key={s.id} role="tab" aria-selected={tab === s.id} className={tab === s.id ? 'on' : ''} onClick={(e) => showTab(e, () => setTab(s.id))}>
              <s.icon size={16} aria-hidden="true" /> {s.label}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab + receiveChain} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {tab === 'send' && <SendPanel notify={notify} />}
          {tab === 'receive' && <ReceivePanel notify={notify} initial={receiveChain} />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/* ---------- profile and settings ---------- */

function Settings({
  email,
  owner,
  tab,
  setTab,
  notify,
  onSignOut,
}: {
  email: string
  owner: string
  tab: ProfileTab
  setTab: (t: ProfileTab) => void
  notify: (m: string) => void
  onSignOut: () => void
}) {
  return (
    <div className="stack">
      <div className="panel profile-head">
        <span className="avatar big">{owner.slice(0, 1)}</span>
        <div className="grow">
          <h2>{owner}</h2>
          <span className="dim">{email}</span>
        </div>
        <span className="pill ok">Signed in through the bank</span>
        <button className="btn ghost" onClick={onSignOut}>
          <LogOut size={15} aria-hidden="true" /> Sign out
        </button>
      </div>

      <div className="subtabs" role="tablist" aria-label="Profile sections">
        <div>
          {PROFILE.map((s) => (
            <button key={s.id} role="tab" aria-selected={tab === s.id} className={tab === s.id ? 'on' : ''} onClick={(e) => showTab(e, () => setTab(s.id))}>
              <s.icon size={16} aria-hidden="true" /> {s.label}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {tab === 'wallets' && <WalletsPanel notify={notify} />}
          {tab === 'security' && <SecurityPanel notify={notify} />}
          {tab === 'recovery' && <RecoveryPanel />}
          {tab === 'rules' && <BankRules notify={notify} />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/* ---------- app ---------- */

function Shell() {
  const access = useAccess()
  const email = access.email ?? ''
  const [tab, setTab] = useState<TabId>('overview')
  const [xTab, setXTab] = useState<TransferTab>('send')
  const [receiveChain, setReceiveChain] = useState<Chain>('BTC')
  const [pTab, setPTab] = useState<ProfileTab>('wallets')
  const [open, setOpen] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([])
  const nextToast = useRef(0)
  const { rows } = useActivity()

  const notify = (msg: string) => {
    const id = ++nextToast.current
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800)
  }

  const goTransfer = (t: TransferTab, chain?: Chain) => {
    if (chain) setReceiveChain(chain)
    setXTab(t)
    setTab('transfer')
  }

  const owner = nameFromEmail(email)
  const pendingCount = rows.filter((r) => !r.confirmed && r.ok).length

  return (
    <div className={`app ${open ? '' : 'collapsed'}`}>
      <a className="skip-link" href="#main">Skip to main content</a>
      <aside className={`rail ${open ? '' : 'collapsed'}`}>
        <div className="rail-head">
          <Wordmark />
          <button className="icon rail-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse menu' : 'Expand menu'} aria-expanded={open}>
            {open ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
          </button>
        </div>
        <p className="entity">Self-custody wallet</p>

        <nav aria-label="Main">
          {NAV.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined} title={t.label}>
              <t.icon size={19} />
              <span className="label">{t.label}</span>
              {t.id === 'history' && pendingCount > 0 && <em>{pendingCount}</em>}
            </button>
          ))}
        </nav>

        <button className={`profile-btn ${tab === 'settings' ? 'on' : ''}`} onClick={() => setTab('settings')} title="Profile and settings" aria-label="Open profile and settings">
          <span className="avatar sm">{owner.slice(0, 1)}</span>
          <span className="label who">
            <b>{owner}</b>
            <small>{email}</small>
          </span>
        </button>
      </aside>

      <main className="main" id="main">
        <header className="top">
          <h1>{TITLES[tab]}</h1>
        </header>

        {access.passkeys?.length === 0 && (
          <div className="banner" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>Your account has no passkey yet. Without one, a transfer needs only your password, and a stolen session could move your funds.</span>
            <button
              className="btn sm"
              onClick={() => {
                setPTab('security')
                setTab('settings')
              }}
            >
              Add a passkey
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.section key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            {tab === 'overview' && (
              <Overview
                setTab={(t) => {
                  if (t === 'settings') setPTab('security')
                  setTab(t)
                }}
                goTransfer={goTransfer}
                notify={notify}
              />
            )}
            {tab === 'transfer' && <Transfer tab={xTab} setTab={setXTab} receiveChain={receiveChain} notify={notify} />}
            {tab === 'history' && <History notify={notify} />}
            {tab === 'settings' && (
              <Settings
                email={email}
                owner={owner}
                tab={pTab}
                setTab={setPTab}
                notify={notify}
                onSignOut={() => {
                  setOpen(false)
                  void access.signOut()
                }}
              />
            )}
          </motion.section>
        </AnimatePresence>
      </main>

      {/* Navigation du pouce, sur téléphone et tablette (sur ordinateur, c'est la colonne de gauche). */}
      <nav className="tabbar" aria-label="Main">
        {NAV.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <span className="tab-icon">
              <t.icon size={22} aria-hidden="true" />
              {t.id === 'history' && pendingCount > 0 && <em aria-label={`${pendingCount} pending`}>{pendingCount}</em>}
            </span>
            <span>{t.id === 'transfer' ? 'Send & receive' : t.id === 'history' ? 'History' : 'Overview'}</span>
          </button>
        ))}
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')} aria-current={tab === 'settings' ? 'page' : undefined}>
          <span className="tab-icon">
            <CircleUser size={22} aria-hidden="true" />
          </span>
          <span>Profile</span>
        </button>
      </nav>

      <div className="toasts" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }}>
              <Check size={15} /> {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ---------- porte d'accès ---------- */

function Gate() {
  const a = useAccess()
  if (a.snapshot.state !== 'ready') return <AccessScreens />
  return (
    <ChainProvider>
      <Shell />
    </ChainProvider>
  )
}

export function App({ backend }: { backend?: Backend } = {}) {
  return (
    <AccessProvider backend={backend}>
      <Gate />
    </AccessProvider>
  )
}
