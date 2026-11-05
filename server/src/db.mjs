import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reauth_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_account ON audit(account_id, seq);
CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  reasons TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS auth_account ON authorizations(account_id, chain, created_at);
CREATE TABLE IF NOT EXISTS passkey_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  issued_at INTEGER,
  cancelled_at INTEGER,
  confirmed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS grants_account ON passkey_grants(account_id, scope);
-- Passkeys gérés par la banque (WebAuthn): la banque est la partie de confiance, le fournisseur de wallet n'en connaît aucun.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  rp_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS creds_account ON webauthn_credentials(account_id);
-- Défis à usage unique, liés à une action, à une session et à l'origine qui les a demandés.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  account_id TEXT,
  session_hash TEXT,
  binding TEXT,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`

// Colonnes ajoutées après la première version du schéma: on les ajoute aux bases existantes.
const MIGRATIONS = [
  ['passkey_grants', 'confirmed_at', 'INTEGER'],
  ['passkey_grants', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  // Session « forte »: un passkey a été vérifié récemment. Autorisation de signer déjà remise pour ce transfert.
  ['sessions', 'strong_at', 'INTEGER'],
  ['authorizations', 'signing_at', 'INTEGER'],
]

export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  for (const [table, column, type] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  return db
}
