const encoder = new TextEncoder()

export const DOWNLOAD_GRANT_TTL_SECONDS = 180

export type DownloadGrantPayload = {
  v: 1
  nonce: string
  slug: string
  packageSha256: string
  exp: number
}

function encode(value: Uint8Array) {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decode(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function sign(secret: string, value: string, usage: KeyUsage) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

export async function createDownloadGrant(secret: string, input: Omit<DownloadGrantPayload, 'v' | 'nonce' | 'exp'>, ttlSeconds = DOWNLOAD_GRANT_TTL_SECONDS) {
  const payload: DownloadGrantPayload = {
    v: 1,
    nonce: crypto.randomUUID(),
    slug: input.slug,
    packageSha256: input.packageSha256,
    exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(ttlSeconds, 300)),
  }
  const encodedPayload = encode(encoder.encode(JSON.stringify(payload)))
  const signature = encode(await sign(secret, encodedPayload, 'sign'))
  return { payload, token: `${encodedPayload}.${signature}` }
}

export async function verifyDownloadGrant(secret: string, token: string, now = Math.floor(Date.now() / 1000)) {
  if (!token || token.length > 2048) return null
  const [encodedPayload, encodedSignature, ...extra] = token.split('.')
  if (!encodedPayload || !encodedSignature || extra.length > 0) return null
  let payload: DownloadGrantPayload
  let signature: Uint8Array
  try {
    payload = JSON.parse(new TextDecoder().decode(decode(encodedPayload))) as DownloadGrantPayload
    signature = decode(encodedSignature)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || payload.v !== 1 || typeof payload.nonce !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug) || !/^[0-9a-f]{64}$/i.test(payload.packageSha256) || !Number.isInteger(payload.exp) || payload.exp < now || signature.byteLength !== 32) return null
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encodedPayload))
  return valid ? payload : null
}
