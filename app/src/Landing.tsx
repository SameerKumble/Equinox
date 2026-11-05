import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Check, ChevronRight, CircleCheck, CircleDashed, CircleX, Fingerprint, Landmark, PenLine, RadioTower, SearchCheck, Server, ShieldCheck, Smartphone, X } from 'lucide-react'
import { demoVerdict } from './landingDemo'
import type { Chain } from './provider/types'
import bitcoinSvg from './assets/bitcoin.svg?raw'
import ethereumSvg from './assets/ethereum.svg?raw'
import solanaSvg from './assets/solana.svg?raw'
import './landing.css'

/* Page d'accueil dans le langage visuel de swissquote.com: fond blanc, titres en capitales grasses, orange de marque
   pour les actions, cartes à coins de 12 px, grands blocs à coins de 32 px. Illustrations vectorielles originales. */

const glyph = (svg: string) => /\sd="([^"]+)"/.exec(svg)?.[1] ?? ''
const GLYPHS: Record<Chain, string> = { BTC: glyph(bitcoinSvg), EVM: glyph(ethereumSvg), SOL: glyph(solanaSvg) }

const CHAINS: { id: Chain; label: string; testnet: string; unit: string; sample: string }[] = [
  { id: 'BTC', label: 'Bitcoin', testnet: 'Bitcoin testnet', unit: 'BTC', sample: 'tb1q9rp4v3rlw47zyzargsfmx6edtrg030adng3rh4' },
  { id: 'EVM', label: 'Ethereum', testnet: 'Base Sepolia', unit: 'ETH', sample: '0x6DB8A8CDE4fF95d95570589D850136D2B0932b1D' },
  { id: 'SOL', label: 'Solana', testnet: 'Solana testnet', unit: 'SOL', sample: 'EWdbpPpotPtJrvBms5j4cVQouo7iR5DVvJjCVL99pAWX' },
]

function useReveal() {
  const reduce = useReducedMotion()
  return (delay = 0) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 24 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, amount: 0.2 },
          transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] as const },
        }
}

function Glyph({ chain }: { chain: Chain }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={GLYPHS[chain]} />
    </svg>
  )
}

function Brand({ href }: { href?: string }) {
  const inner = (
    <>
      <span className="lp-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M3.5 13.5c2.6-4.2 5.2 3.4 8.4-.6s5.6-3.2 8.6-1.6" fill="none" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </span>
      <span className="lp-name">equinox</span>
      <span className="lp-by">offline simulation</span>
    </>
  )
  return href ? (
    <a className="lp-brand" href={href} aria-label="equinox, home">
      {inner}
    </a>
  ) : (
    <span className="lp-brand">{inner}</span>
  )
}

/* Héros: trois pièces (les trois réseaux) posées sur un ruban, sur l'orange de la marque. */
const RIBBON_TOP = 'M-40 560C160 520 300 440 470 410C640 380 760 280 910 230C1060 180 1240 140 1420 120'
const RIBBON = `${RIBBON_TOP}L1420 210C1240 230 1060 280 910 330C760 380 640 500 470 530C300 560 160 650 -40 700Z`
const COINS: { chain: Chain; x: number; y: number; r: number }[] = [
  { chain: 'BTC', x: 470, y: 340, r: 90 },
  { chain: 'EVM', x: 697, y: 253, r: 94 },
  { chain: 'SOL', x: 910, y: 154, r: 96 },
]

function HeroArt() {
  return (
    <svg className="lp-art" viewBox="0 0 1376 560" preserveAspectRatio="xMidYMin slice" role="img" aria-label="Three coins, Bitcoin, Ethereum and Solana, resting on a ribbon">
      <defs>
        <linearGradient id="lp-ribbon" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.97" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.55" />
        </linearGradient>
        <radialGradient id="lp-face" cx="0.36" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#fff3ee" />
          <stop offset="1" stopColor="#ffd3c3" />
        </radialGradient>
        <filter id="lp-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      <circle cx="1190" cy="30" r="270" fill="#fff" opacity="0.1" />
      <circle cx="140" cy="80" r="160" fill="#fff" opacity="0.07" />
      {/* Le tout remonte un peu: la carte du titre chevauche le bas de l'illustration. */}
      <g transform="translate(0 -40)">
        <path d={RIBBON} fill="#692616" opacity="0.22" filter="url(#lp-blur)" transform="translate(0 28)" />
        <path d={RIBBON} fill="url(#lp-ribbon)" />
        <path d={RIBBON_TOP} fill="none" stroke="#fff" strokeWidth="3" />
        {COINS.map((c, i) => (
          <g key={c.chain} transform={`translate(${c.x} ${c.y})`}>
            <g className="lp-float" style={{ animationDelay: `${-i * 1.4}s` }}>
              <ellipse cx="16" cy={c.r * 0.95} rx={c.r * 0.8} ry={c.r * 0.18} fill="#692616" opacity="0.4" filter="url(#lp-blur)" />
              <g transform="rotate(-12)">
                <circle cx="10" cy="12" r={c.r} fill="#c8431f" />
                <circle r={c.r} fill="#ff7a55" />
                <circle r={c.r * 0.84} fill="url(#lp-face)" />
                <circle r={c.r * 0.84} fill="none" stroke="#fff" strokeWidth="3" />
                <path d={GLYPHS[c.chain]} fill="#fa5b35" transform={`translate(${-c.r * 0.46} ${-c.r * 0.46}) scale(${(c.r * 0.92) / 24})`} />
              </g>
            </g>
          </g>
        ))}
      </g>
    </svg>
  )
}

/* Aperçu du contrôle de la banque, à côté de l'explication des trois rôles. */
function ApprovalMock() {
  return (
    <div className="lp-mock" role="img" aria-label="Illustration: the bank checks a transfer of 0.001 ETH, then lets it through">
      <div className="lp-mock-head">
        <span className="lp-icon sm">
          <ShieldCheck size={18} aria-hidden="true" />
        </span>
        <span className="lp-mock-title">
          <b>Bank check</b>
          <small>Base Sepolia</small>
        </span>
        <span className="lp-mock-pill">Approved</span>
      </div>
      <p className="lp-mock-amount">0.001 ETH</p>
      <p className="lp-mock-to">
        to <code>0x6DB8…2b1D</code>
      </p>
      <ul>
        <li>
          <CircleCheck size={18} aria-hidden="true" /> Within your daily limit
        </li>
        <li>
          <CircleCheck size={18} aria-hidden="true" /> Within your transfer limit
        </li>
        <li>
          <CircleCheck size={18} aria-hidden="true" /> Approved with your passkey
        </li>
      </ul>
      <p className="lp-mock-foot">
        <PenLine size={16} aria-hidden="true" /> Signed by your device and the provider together
      </p>
    </div>
  )
}

/* Illustration interactive: les mêmes règles que le serveur de la banque, avec une courte liste d'exemple. */
function TransferCheck() {
  const [chain, setChain] = useState<Chain>('BTC')
  const [amount, setAmount] = useState('0.005')
  const [to, setTo] = useState(CHAINS[0].sample)
  const meta = CHAINS.find((c) => c.id === chain)!

  const verdict = demoVerdict(chain, to, Number(amount.replace(',', '.')))
  const refused = !verdict.allowed

  return (
    <form className="lp-check" onSubmit={(e) => e.preventDefault()} aria-label="Try a transfer (illustration)">
      <div className="lp-check-grid">
        <label className="field">
          <span>Network</span>
          <select
            name="network"
            value={chain}
            onChange={(e) => {
              const next = e.target.value as Chain
              setChain(next)
              setTo(CHAINS.find((c) => c.id === next)!.sample)
            }}
          >
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Amount in {meta.unit}</span>
          <input name="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Recipient address</span>
        <input name="recipient" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className={`lp-verdict ${refused ? 'no' : 'yes'}`} role="status" aria-live="polite">
        {refused ? <X size={20} aria-hidden="true" /> : <Check size={20} aria-hidden="true" />}
        <div>
          <strong>{refused ? 'The bank refuses this transfer' : 'The bank lets this transfer through'}</strong>
          <p>{verdict.reasons.join('. ')}</p>
        </div>
      </div>
    </form>
  )
}

const ROLES = [
  { icon: Smartphone, title: 'Your device', text: 'Holds your share of the key, locked by a passcode only you know. Without it, the share is unreadable.' },
  { icon: Server, title: 'The wallet provider', text: 'Holds the other share. It signs together with you, never on its own.' },
  { icon: Landmark, title: 'The bank', text: 'Holds no share. It checks your passkey, your limits and approved-address rules, and it can refuse. It cannot sign.' },
]

const STEPS = [
  { icon: SearchCheck, title: 'Check', text: 'The bank checks the transfer amount and your approved-address rules.' },
  { icon: Fingerprint, title: 'Approve', text: 'You confirm with your fingerprint or your face. The bank checks your passkey, then lets the provider sign, once.' },
  { icon: PenLine, title: 'Sign', text: "Your share and the provider's sign together. A full key never exists." },
  { icon: RadioTower, title: 'Broadcast', text: 'The signed transaction goes to the network.' },
]

export function Landing() {
  const reveal = useReveal()

  return (
    <div className="lp">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>

      <header className="lp-nav">
        <div className="lp-wrap">
          <Brand href="#top" />
          <nav className="lp-links" aria-label="Main">
            <a href="#key">How it works</a>
            <a href="#try">Try it</a>
            <a href="#send">Sending</a>
            <a href="#recovery">Recovery</a>
          </nav>
          <div className="lp-nav-cta">
            <a className="lp-btn outline" href="#try">
              Try a transfer
            </a>
            <a className="lp-btn" href="#app">
              Open the app
            </a>
          </div>
        </div>
      </header>

      <main id="content">
        <section className="lp-hero" id="top">
          <div className="lp-art-box">
            <HeroArt />
          </div>
          <div className="lp-hero-card">
            <h1 className="lp-display">
              Self-custody.
              <br />
              With a bank behind it.
            </h1>
            <p>No seed phrase. Your key is never in one place. The bank can refuse a transfer, never sign one.</p>
            <div className="lp-actions">
              <a className="lp-btn lg" href="#app">
                Open the app
              </a>
              <a className="lp-textlink" href="#key">
                How it works <ChevronRight size={20} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section className="lp-section lp-wrap" id="key">
          <div className="lp-why">
            <motion.div {...reveal()}>
              <p className="lp-eyebrow">Why equinox</p>
              <h2 className="lp-display">Nobody signs alone.</h2>
              <p className="lp-lead">
                A transfer needs your share of the key and the provider's. The bank stands in front of both and can say no.
              </p>
            </motion.div>
            <motion.div className="lp-mock-box" {...reveal(0.1)}>
              <ApprovalMock />
            </motion.div>
          </div>
          <div className="lp-features">
            {ROLES.map((r, i) => (
              <motion.article key={r.title} className="lp-feature" {...reveal(i * 0.08)}>
                <span className="lp-icon">
                  <r.icon size={22} aria-hidden="true" />
                </span>
                <h3>{r.title}</h3>
                <p>{r.text}</p>
              </motion.article>
            ))}
          </div>
        </section>

        <section className="lp-section lp-wrap" id="try">
          <motion.div className="lp-band" {...reveal()}>
            <p className="lp-eyebrow">Live demo</p>
            <h2 className="lp-display">Try a transfer</h2>
            <p className="lp-lead">The bank's rules, applied as you type. A short sample list stands in for the full one its server uses.</p>
            <TransferCheck />
          </motion.div>
        </section>

        <section className="lp-section lp-wrap" id="send">
          <motion.div {...reveal()}>
            <p className="lp-eyebrow">Sending</p>
            <h2 className="lp-display">What happens when you send</h2>
          </motion.div>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <motion.li key={s.title} className="lp-step" {...reveal(i * 0.06)}>
                <div className="lp-step-top">
                  <span className="lp-icon">
                    <s.icon size={22} aria-hidden="true" />
                  </span>
                  <span className="lp-step-num" aria-hidden="true">
                    0{i + 1}
                  </span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </motion.li>
            ))}
          </ol>
        </section>

        <div className="lp-pill-row">
          <a className="lp-pill" href="#app">
            <span>Open your wallet</span>
            <ArrowRight size={30} aria-hidden="true" />
          </a>
          <ul className="lp-coins" aria-label="Supported networks">
            {CHAINS.map((c) => (
              <li key={c.id} className="lp-coin" title={c.testnet}>
                <Glyph chain={c.id} />
                <span className="sr-only">{c.testnet}</span>
              </li>
            ))}
          </ul>
        </div>

        <section className="lp-section lp-wrap" id="recovery">
          <motion.div className="lp-recovery-art" {...reveal()}>
            <p className="lp-eyebrow">Recovery</p>
            <h2 className="lp-display">Lost your phone? Keep your wallet.</h2>
          </motion.div>
          <div className="lp-compare">
            <motion.div className="lp-card" {...reveal(0.05)}>
              <h3>The bank can</h3>
              <ul>
                <li>
                  <CircleCheck size={20} aria-hidden="true" /> Verify who you are, with your passkey or your password
                </li>
                <li>
                  <CircleCheck size={20} aria-hidden="true" /> Hold a new passkey back for a security delay
                </li>
                <li>
                  <CircleCheck size={20} aria-hidden="true" /> Refuse a transfer that breaks your limits
                </li>
              </ul>
            </motion.div>
            <motion.div className="lp-card no" {...reveal(0.1)}>
              <h3>The bank cannot</h3>
              <ul>
                <li>
                  <CircleX size={20} aria-hidden="true" /> Sign for you
                </li>
                <li>
                  <CircleX size={20} aria-hidden="true" /> Read or reset your passcode
                </li>
                <li>
                  <CircleX size={20} aria-hidden="true" /> Move your funds
                </li>
              </ul>
            </motion.div>
          </div>
          <motion.div className="lp-recovery-text" {...reveal(0.1)}>
            <p className="lp-lead">
              Sign in to your bank account on the new device, enter your passcode, and register a new passkey. The bank makes you
              wait before it accepts it, and you can cancel from your other devices. Your addresses stay the same.
            </p>
            <p className="lp-notice">If you lose your passcode, nobody can recover the wallet. That is the cost of owning your keys.</p>
          </motion.div>
        </section>

        <section className="lp-section lp-wrap">
          <div className="lp-status">
            <motion.div className="lp-status-art" {...reveal()}>
              {CHAINS.map((c) => (
                <div key={c.id} className="lp-badge">
                  <Glyph chain={c.id} />
                  <span>
                    {c.testnet}
                    <small>{c.label}, test coins only</small>
                  </span>
                </div>
              ))}
            </motion.div>
            <motion.div {...reveal(0.1)}>
              <p className="lp-eyebrow">Prototype</p>
              <h2 className="lp-display">Where it stands</h2>
              <div className="lp-lists">
                <div>
                  <h3>Working</h3>
                  <ul>
                    <li><CircleCheck size={18} aria-hidden="true" /> Wallets on Bitcoin, Ethereum and Solana, with signatures checked on your device</li>
                    <li><CircleCheck size={18} aria-hidden="true" /> Passkeys held by the bank: sign in, approve every transfer, security delay for a lost device</li>
                    <li><CircleCheck size={18} aria-hidden="true" /> The provider refuses to sign without the bank's one-time go-ahead</li>
                    <li><CircleCheck size={18} aria-hidden="true" /> Approval of a new device by email</li>
                    <li><CircleCheck size={18} aria-hidden="true" /> Bank checks on every transfer: limits and approved-address rules</li>
                    <li><CircleCheck size={18} aria-hidden="true" /> An audit trail that shows when a line has been edited</li>
                  </ul>
                </div>
                <div className="next">
                  <h3>Next</h3>
                  <ul>
                    <li><CircleDashed size={18} aria-hidden="true" /> Recovery on a new device from start to finish, being verified with the wallet provider</li>
                    <li><CircleDashed size={18} aria-hidden="true" /> Real transactions on the three networks, being tried with test coins</li>
                    <li><CircleDashed size={18} aria-hidden="true" /> Tying the bank's go-ahead to the exact transaction, not only to the transfer it checked</li>
                    <li><CircleDashed size={18} aria-hidden="true" /> Network fees paid by the bank</li>
                  </ul>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="lp-section lp-wrap">
          <motion.div className="lp-final" {...reveal()}>
            <div>
              <p className="lp-eyebrow">Test networks only</p>
              <h2 className="lp-display">See it running.</h2>
            </div>
            <a className="lp-btn lg white" href="#app">
              Open the app <ArrowRight size={20} aria-hidden="true" />
            </a>
          </motion.div>
        </section>
      </main>

      <footer className="lp-footer lp-wrap">
        <div className="lp-foot-card">
          <div>
            <Brand />
            <p>A self-custody wallet with a bank behind it.</p>
          </div>
          <div>
            <h3>The wallet</h3>
            <ul>
              <li><a href="#key">How it works</a></li>
              <li><a href="#send">Sending</a></li>
              <li><a href="#recovery">Recovery</a></li>
            </ul>
          </div>
          <div>
            <h3>Try it</h3>
            <ul>
              <li><a href="#try">Try a transfer</a></li>
              <li><a href="#app">Open the app</a></li>
            </ul>
          </div>
          <div>
            <h3>Networks</h3>
            <ul>
              {CHAINS.map((c) => (
                <li key={c.id}>{c.testnet}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="lp-legal">
          <h3>Offline simulation</h3>
          <p>
            Test accounts, wallet balances and transfers are stored locally; no real funds or blockchain connections are used.
          </p>
          <div className="lp-legal-row">
            <span>Local demo only. No external account or service is contacted.</span>
            <span>Built as a prototype during THE hackathon, Lausanne, 2026</span>
            <span>Sameer Kumble</span>
            <span>sameerkumble.science@gmail.com</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
