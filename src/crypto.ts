const encoder = new TextEncoder()

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Base64 for arbitrary bytes, a byte at a time so a large buffer cannot overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function toBase64Url(input: string | Uint8Array): string {
  const base64 = typeof input === 'string' ? btoa(input) : toBase64(input)
  return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function hmacSha256(secret: string, body: string | Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', toBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, toBytes(body) as BufferSource)
}

/** Lowercase hex HMAC-SHA256 of `body` under `secret`. */
export async function hmacSha256Hex(secret: string, body: string | Uint8Array): Promise<string> {
  return toHex(await hmacSha256(secret, body))
}

/** Constant-time comparison of two ASCII strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let mismatch = 0
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}

function decodePem(pem: string): { der: Uint8Array, pkcs1: boolean } {
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY')
  const body = pem.replace(/-----(?:BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  const binary = atob(body)
  const der = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    der[index] = binary.charCodeAt(index)
  }
  return { der, pkcs1 }
}

function derLength(length: number): number[] {
  if (length < 0x80) {
    return [length]
  }
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xFF)
    remaining >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}

/**
 * Wraps a PKCS#1 RSA key in a PKCS#8 `PrivateKeyInfo`. GitHub App keys are
 * distributed as PKCS#1, which Web Crypto cannot import directly.
 */
function pkcs1ToPkcs8(der: Uint8Array): Uint8Array {
  const algorithm = [0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octetString = [0x04, ...derLength(der.length), ...der]
  const contents = [0x02, 0x01, 0x00, ...algorithm, ...octetString]
  return new Uint8Array([0x30, ...derLength(contents.length), ...contents])
}

/** The claims of a signed JWT. Other claims are passed through. */
export interface JwtClaims {
  /** The issuer, such as the app ID. */
  iss: string
  /** When the token was issued, in seconds since the epoch. */
  iat: number
  /** When the token expires, in seconds since the epoch. */
  exp: number
  [claim: string]: unknown
}

/** Signs an RS256 JWT with a PEM-encoded RSA private key. */
export async function signRs256Jwt(privateKeyPem: string, claims: JwtClaims): Promise<string> {
  const { der, pkcs1 } = decodePem(privateKeyPem)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    (pkcs1 ? pkcs1ToPkcs8(der) : der) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const payload = `${toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${toBase64Url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(payload) as BufferSource)
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`
}

/** The value of a header, whatever the casing of `name`, from a `Headers` object or a plain record. */
export function headerValue(headers: Headers | Record<string, string>, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value
    }
  }
  return undefined
}

/** A request body as text. */
export function bodyText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body)
}

/** Lowercase hex SHA-256 of `body`. */
export async function sha256Hex(body: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', toBytes(body) as BufferSource))
}

/** Signs an EdDSA (Ed25519) JWT with a PKCS#8 PEM private key. `kid` goes in the JOSE header. */
export async function signEdDsaJwt(privateKeyPem: string, claims: JwtClaims, kid?: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', decodePem(privateKeyPem).der as BufferSource, { name: 'Ed25519' }, false, ['sign'])
  const payload = `${toBase64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', ...kid ? { kid } : {} }))}.${toBase64Url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign('Ed25519', key, encoder.encode(payload) as BufferSource)
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`
}

/** An Ed25519 public key in JWK form, as served from a JWKS endpoint. */
export interface Ed25519Jwk {
  /** The key type, always `OKP`. */
  kty: 'OKP'
  /** The curve, always `Ed25519`. */
  crv: 'Ed25519'
  /** The public key, base64url encoded. */
  x: string
  kid?: string
}

/** Verifies an Ed25519 signature (base64) over `data` with a JWK public key. */
export async function verifyEd25519(jwk: Ed25519Jwk, data: string | Uint8Array, signatureBase64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, false, ['verify'])
    const binary = atob(signatureBase64)
    const signature = Uint8Array.from(binary, char => char.charCodeAt(0))
    return await crypto.subtle.verify('Ed25519', key, signature as BufferSource, toBytes(data) as BufferSource)
  }
  catch {
    return false
  }
}

/** Base64 HMAC-SHA256 of `body` under `secret`. */
export async function hmacSha256Base64(secret: string, body: string | Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await hmacSha256(secret, body)))
}
