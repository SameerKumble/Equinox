import { sha256hex } from './crypto.mjs'

// Journal d'audit à chaîne de hachage: chaque entrée contient le hachage de la précédente.
// Modifier ou supprimer une ligne casse la chaîne, et la vérification le détecte.
const GENESIS = '0'.repeat(64)

const digest = (prev, at, action, detail) => sha256hex(`${prev}|${at}|${action}|${detail}`)

export function appendAudit(db, accountId, action, detail = {}, at = Date.now()) {
  const last = db.prepare('SELECT hash FROM audit WHERE account_id = ? ORDER BY seq DESC LIMIT 1').get(accountId)
  const prev = last?.hash ?? GENESIS
  const json = JSON.stringify(detail)
  const hash = digest(prev, at, action, json)
  db.prepare('INSERT INTO audit (account_id, at, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(accountId, at, action, json, prev, hash)
  return hash
}

export function listAudit(db, accountId, limit = 100) {
  return db
    .prepare('SELECT seq, at, action, detail, hash FROM audit WHERE account_id = ? ORDER BY seq DESC LIMIT ?')
    .all(accountId, limit)
    .map((r) => ({ seq: r.seq, at: r.at, action: r.action, detail: JSON.parse(r.detail), hash: r.hash }))
}

/** Recalcule toute la chaîne. Retourne la première rupture, s'il y en a une. */
export function verifyAudit(db, accountId) {
  const rows = db.prepare('SELECT seq, at, action, detail, prev_hash, hash FROM audit WHERE account_id = ? ORDER BY seq ASC').all(accountId)
  let prev = GENESIS
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== digest(prev, r.at, r.action, r.detail)) return { ok: false, count: rows.length, brokenAtSeq: r.seq }
    prev = r.hash
  }
  return { ok: true, count: rows.length }
}
