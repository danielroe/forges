import { Buffer } from 'node:buffer'
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, signEdDsaJwt, signRs256Jwt, timingSafeEqual, verifyEd25519 } from '../../src/crypto.ts'
import { verifyForgejoSignature } from '../../src/forgejo/webhooks.ts'
import { verifyGitHubSignature } from '../../src/github/webhooks.ts'

const body = '{"action":"created"}'
const secret = 'shhh'

describe('signatures', () => {
  it('verifies a GitHub sha256 signature and rejects a tampered body', async () => {
    const signature = `sha256=${await hmacSha256Hex(secret, body)}`

    expect(await verifyGitHubSignature({
      headers: { 'X-Hub-Signature-256': signature },
      body,
    }, secret)).toBe(true)
    expect(await verifyGitHubSignature({
      headers: { 'X-Hub-Signature-256': signature },
      body: `${body} `,
    }, secret)).toBe(false)
  })

  it('verifies a Forgejo signature under either vendor header', async () => {
    const signature = await hmacSha256Hex(secret, body)

    expect(await verifyForgejoSignature({
      headers: { 'X-Forgejo-Signature': signature },
      body,
    }, secret)).toBe(true)
    expect(await verifyForgejoSignature({
      headers: {
        'X-Gitea-Signature': signature.toUpperCase(),
      },
      body,
    }, secret)).toBe(true)
    expect(await verifyForgejoSignature({
      headers: {
        'X-Gitea-Signature': '0'.repeat(64),
      },
      body,
    }, secret)).toBe(false)
  })

  it('rejects a delivery with no signature header or no secret', async () => {
    const signature = `sha256=${await hmacSha256Hex(secret, body)}`

    expect(await verifyGitHubSignature({ headers: {}, body }, secret)).toBe(false)
    expect(await verifyGitHubSignature({
      headers: { 'x-hub-signature-256': signature },
      body,
    }, undefined)).toBe(false)
  })

  it('accepts a per-delivery secret override', async () => {
    const signature = `sha256=${await hmacSha256Hex('other', body)}`

    expect(await verifyGitHubSignature({
      headers: { 'x-hub-signature-256': signature },
      body,
      secret: 'other',
    }, secret)).toBe(true)
  })

  it('compares strings without false positives on prefixes or length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('abcabc', 'abc')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('a', '')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })

  it('verifies a Uint8Array body byte for byte', async () => {
    const bytes = new TextEncoder().encode(body)
    const signature = `sha256=${await hmacSha256Hex(secret, bytes)}`

    expect(await verifyGitHubSignature({
      headers: { 'x-hub-signature-256': signature },
      body: bytes,
    }, secret)).toBe(true)
  })
})

describe('signRs256Jwt', () => {
  it.each(['pkcs1', 'pkcs8'] as const)('signs a verifiable JWT from a %s key', async (type) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type, format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const now = Math.floor(Date.now() / 1000)

    const jwt = await signRs256Jwt(privateKey, { iss: '12345', iat: now, exp: now + 540 })
    const [header, payload, signature] = jwt.split('.') as [string, string, string]

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe('12345')
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url')),
    ).toBe(true)
  })
})

async function ed25519() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as { kty: 'OKP', crv: 'Ed25519', x: string }
  return { pem, jwk, privateKey: pair.privateKey }
}

describe('ed25519', () => {
  it('signs an EdDSA JWT whose signature verifies against the JWK', async () => {
    const { pem, jwk } = await ed25519()
    const jwt = await signEdDsaJwt(pem, {
      iss: 'app_1',
      iat: 1,
      exp: 2,
      aud: 'origin-apps',
    }, 'app_1')
    const [header, payload, signature] = jwt.split('.')
    const base64 = signature!.replaceAll('-', '+').replaceAll('_', '/')

    expect(JSON.parse(atob(header!))).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'app_1' })
    expect(await verifyEd25519(jwk, `${header}.${payload}`, base64)).toBe(true)
    expect(await verifyEd25519(jwk, `${header}.tampered`, base64)).toBe(false)
  })
})
