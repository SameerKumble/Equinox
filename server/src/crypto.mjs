import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex')

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function hashPassword(password) {
  const salt = randomBytes(16)
  return { salt: salt.toString('hex'), hash: scryptSync(password, salt, 64, SCRYPT).toString('hex') }
}

export function verifyPassword(password, saltHex, hashHex) {
  const candidate = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT)
  const expected = Buffer.from(hashHex, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export const newToken = () => randomBytes(32).toString('base64url')
export const newId = () => randomBytes(12).toString('hex')
