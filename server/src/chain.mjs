import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidAddress } from './policy.mjs'

// All balances and transactions are local simulation data; no chain RPC or explorer is contacted.

export class ChainError extends Error {
  constructor(message) {
    super(message)
    this.code = 'chain_unavailable'
  }
}

/* ------------------------------ normalisation ------------------------------ */
// Chaque transaction devient { hash, time (ms ou null), confirmed, ok, direction ('in'|'out'|'self'), amount, fee, counterparty }.
// `amount` est ce qui a réellement changé de mains (hors frais), dans l'unité de la chaîne; `fee` n'est donné que si c'est nous qui l'avons payé.

const SAT = 1e8

export function parseBtc(address, stats, txs) {
  const net = (s) => (s?.funded_txo_sum ?? 0) - (s?.spent_txo_sum ?? 0)
  const balance = (net(stats.chain_stats) + net(stats.mempool_stats)) / SAT
  return {
    balance,
    txs: txs.map((t) => {
      const received = t.vout.filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0)
      const sent = t.vin.filter((i) => i.prevout?.scriptpubkey_address === address).reduce((s, i) => s + i.prevout.value, 0)
      const outgoing = sent > 0
      const leftSat = outgoing ? sent - received - t.fee : received
      const other = outgoing
        ? t.vout.find((o) => o.scriptpubkey_address && o.scriptpubkey_address !== address)?.scriptpubkey_address
        : t.vin.find((i) => i.prevout?.scriptpubkey_address && i.prevout.scriptpubkey_address !== address)?.prevout.scriptpubkey_address
      return {
        hash: t.txid,
        time: t.status?.confirmed && t.status.block_time ? t.status.block_time * 1000 : null,
        confirmed: !!t.status?.confirmed,
        ok: true,
        direction: !outgoing ? 'in' : leftSat <= 0 ? 'self' : 'out',
        amount: Math.max(leftSat, 0) / SAT,
        fee: outgoing ? t.fee / SAT : null,
        counterparty: other ?? null,
      }
    }),
  }
}

const WEI = 1e18
const wei = (v) => Number(BigInt(v ?? '0')) / WEI

export function parseEvm(address, info, items) {
  const me = address.toLowerCase()
  return {
    balance: wei(info?.coin_balance),
    txs: items.map((t) => {
      const from = t.from?.hash?.toLowerCase()
      const to = t.to?.hash?.toLowerCase()
      const outgoing = from === me
      return {
        hash: t.hash,
        time: t.timestamp ? Date.parse(t.timestamp) : null,
        confirmed: t.status != null,
        ok: t.status !== 'error',
        direction: outgoing ? (to === me ? 'self' : 'out') : 'in',
        amount: wei(t.value),
        fee: outgoing ? wei(t.fee?.value) : null,
        counterparty: (outgoing ? to : from) ?? null,
      }
    }),
  }
}

const LAMPORTS = 1e9

/** `sigs`: résultat de getSignaturesForAddress; `txs`: résultats de getTransaction dans le même ordre (null si introuvable). */
export function parseSol(address, balanceLamports, sigs, txs) {
  const out = []
  sigs.forEach((s, i) => {
    const tx = txs[i]
    const keys = tx?.transaction?.message?.accountKeys?.map((k) => (typeof k === 'string' ? k : k.pubkey))
    const idx = keys?.indexOf(address) ?? -1
    const base = { hash: s.signature, time: s.blockTime ? s.blockTime * 1000 : null, confirmed: true, ok: !s.err }
    if (!tx || idx < 0) {
      out.push({ ...base, direction: 'in', amount: 0, fee: null, counterparty: null, unknown: true })
      return
    }
    const delta = tx.meta.postBalances[idx] - tx.meta.preBalances[idx]
    const payer = idx === 0
    const fee = tx.meta.fee
    const movedLamports = payer ? -delta - fee : -delta
    const outgoing = delta < 0
    // La contrepartie est le compte dont le solde a varié dans le sens opposé, le plus fortement.
    let other = null
    let best = 0
    keys.forEach((k, j) => {
      if (j === idx) return
      const d = tx.meta.postBalances[j] - tx.meta.preBalances[j]
      const score = outgoing ? d : -d
      if (score > best) {
        best = score
        other = k
      }
    })
    out.push({
      ...base,
      direction: outgoing ? (movedLamports <= 0 ? 'self' : 'out') : 'in',
      amount: (outgoing ? Math.max(movedLamports, 0) : delta) / LAMPORTS,
      fee: payer ? fee / LAMPORTS : null,
      counterparty: other,
    })
  })
  return { balance: balanceLamports / LAMPORTS, txs: out }
}

const UNIT = { BTC: 'BTC', EVM: 'ETH', SOL: 'SOL' }
const INITIAL_BALANCE = { BTC: 0.05, EVM: 2, SOL: 20 }
const ESTIMATED_FEE = { BTC: 0.00001, EVM: 0.0001, SOL: 0.000005 }
const MAX_CACHED = 500
const addressKey = (chain, address) => `${chain}:${chain === 'EVM' || (chain === 'BTC' && /^tb?1/i.test(address)) ? address.toLowerCase() : address}`
const tx = ({ hash, time, direction, amount, fee, counterparty }) => ({
  hash,
  time,
  confirmed: true,
  ok: true,
  direction,
  amount,
  fee,
  counterparty,
})

/** Deterministic local ledger used by the offline wallet simulation. */
export function createChainReader({ dataDir, now = Date.now } = {}) {
  const file = dataDir ? join(dataDir, 'chain-simulation.json') : undefined
  const accounts = new Map(
    file && existsSync(file)
      ? Object.entries(JSON.parse(readFileSync(file, 'utf8')))
      : [],
  )
  const persist = () => {
    if (file) writeFileSync(file, JSON.stringify(Object.fromEntries(accounts)))
  }
  const getAccount = (chain, address) => {
    const key = addressKey(chain, address)
    if (!accounts.has(key)) accounts.set(key, { balance: INITIAL_BALANCE[chain], txs: [] })
    return accounts.get(key)
  }

  return {
    async read(chain, address) {
      if (!(chain in UNIT) || !isValidAddress(chain, address)) throw new ChainError('Unknown network or invalid address')
      const state = getAccount(chain, address)
      return {
        chain,
        address,
        unit: UNIT[chain],
        balance: state.balance,
        txs: [...state.txs].sort((a, b) => b.time - a.time).slice(0, MAX_CACHED),
        estimatedFee: ESTIMATED_FEE[chain],
        source: 'local simulation',
        fetchedAt: now(),
      }
    },

    recordTransfer({ chain, from, to, amount, hash }) {
      if (!(chain in UNIT) || !isValidAddress(chain, from) || !isValidAddress(chain, to) || !Number.isFinite(amount) || amount <= 0) {
        throw new ChainError('Invalid local simulated transfer')
      }
      const time = now()
      const fee = ESTIMATED_FEE[chain]
      const sender = getAccount(chain, from)
      const recipient = getAccount(chain, to)
      if (sender.balance < amount + fee) throw new ChainError('The simulated wallet has insufficient funds')
      sender.balance -= amount + fee
      if (addressKey(chain, from) === addressKey(chain, to)) {
        sender.txs.unshift(tx({ hash, time, direction: 'self', amount: 0, fee, counterparty: to }))
      } else {
        recipient.balance += amount
        sender.txs.unshift(tx({ hash, time, direction: 'out', amount, fee, counterparty: to }))
        recipient.txs.unshift(tx({ hash, time, direction: 'in', amount, fee: null, counterparty: from }))
      }
      persist()
    },
  }
}
