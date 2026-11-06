/**
 * Host-entry contract test.
 *
 * The /xhs/* bridge lives on the web-server service. Profile bundle rows mount
 * before that service exists, so the plugin must declare it as a hard injection
 * instead of reading it best-effort inside `apply` (that race silently skipped
 * every route and left `/xhs/state` at 404).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

test('host entry exports the row contract', () => {
  assert.equal(name, 'dsh-xhs-evaluator')
  assert.equal(typeof apply, 'function')
})

test('host entry injects llm and webServer as hard dependencies', () => {
  assert.ok(Array.isArray(inject), 'inject must be an array')
  assert.ok(inject.includes('llm'), 'model calls go through the host llm service')
  assert.ok(
    inject.includes('webServer'),
    'webServer must be injected: rows mount before the service exists, so ctx.get("webServer") is undefined in apply',
  )
})
