import assert from 'node:assert/strict'
import test from 'node:test'

import { createDownloadGrant, verifyDownloadGrant } from '../src/lib/download-grant.ts'

const packageSha256 = 'a'.repeat(64)

test('creates a grant bound to one skin package and verifies it', async () => {
  const { payload, token } = await createDownloadGrant('test-download-secret', { slug: 'miku-signal', packageSha256 }, 180)
  const verified = await verifyDownloadGrant('test-download-secret', token, payload.exp - 1)
  assert.deepEqual(verified, payload)
  assert.equal(await verifyDownloadGrant('wrong-secret', token, payload.exp - 1), null)
})

test('rejects tampered, expired, and malformed grants', async () => {
  const { payload, token } = await createDownloadGrant('test-download-secret', { slug: 'miku-signal', packageSha256 }, 180)
  const [, signature] = token.split('.')
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, slug: 'other-theme' })).toString('base64url')
  assert.equal(await verifyDownloadGrant('test-download-secret', `${tamperedPayload}.${signature}`, payload.exp - 1), null)
  assert.equal(await verifyDownloadGrant('test-download-secret', token, payload.exp), null)
  assert.equal(await verifyDownloadGrant('test-download-secret', 'not-a-grant'), null)
})
