import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { checkProductionService, waitForProductionReady } from './local-production-runtime.mjs'

const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }

async function fixture(t, handle = () => false) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (handle(request, response)) return
    if (request.url === '/health/identity') response.end(JSON.stringify(expected))
    else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'ok' } }))
    else response.end('<script src="/assets/dashboard.js"></script>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` }
}

test('a slow service start does not consume the post-start readiness deadline', async t => {
  let listening = false
  const f = await fixture(t, (request) => {
    if (listening) return false
    request.socket.destroy()
    return true
  })
  let rolledBack = false
  let smoked = false
  await waitForProductionReady({ origin: f.origin, expected, timeoutMs: 800,
    start: async () => { await delay(1100); listening = true },
    rollback: () => { rolledBack = true }, smoke: () => { smoked = true } })
  assert.equal(rolledBack, false)
  assert.equal(smoked, true)
  assert.ok(f.requests.filter(path => path === '/health/identity').length > 1)
})

test('connection refused before listening is retried until the API is ready', async t => {
  const f = await fixture(t)
  const port = f.server.address().port
  await new Promise(resolve => f.server.close(resolve))
  await waitForProductionReady({ origin: f.origin, expected, timeoutMs: 2000,
    start: async () => {
      await delay(100)
      f.server.listen(port, '127.0.0.1')
      await once(f.server, 'listening')
    } })
  assert.ok(f.requests.includes('/workspaces'))
})

for (const path of ['/health/identity', '/health/ready', '/workspaces']) {
  test(`a reset connection at ${path} is retried without rolling back`, async t => {
    let reset = false
    const f = await fixture(t, (request) => {
      if (request.url !== path || reset) return false
      reset = true
      request.socket.destroy()
      return true
    })
    let smoked = false
    await waitForProductionReady({ origin: f.origin, expected, timeoutMs: 2000,
      rollback: () => assert.fail('A transient reset must not roll back'),
      smoke: () => { smoked = true } })
    assert.equal(smoked, true)
    assert.ok(f.requests.filter(url => url === path).length >= 2)
  })
}

test('an unavailable API fails at the deadline with a readiness diagnostic', async t => {
  const f = await fixture(t, request => { request.socket.destroy(); return true })
  let rolledBack = false
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 100,
    rollback: () => { rolledBack = true }, smoke: () => assert.fail('API never became ready') }),
  /readiness timed out.*fetch failed.*journalctl/i)
  assert.equal(rolledBack, true)
})

test('an API that keeps reporting not ready fails at the deadline', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url !== '/health/ready') return false
    response.writeHead(503).end(JSON.stringify({ checks: { database: 'unavailable' } }))
    return true
  })
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 100 }),
    /Readiness returned HTTP 503/)
  assert.equal(f.requests.includes('/workspaces'), false)
})

test('a wrong release identity fails immediately without retrying', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url !== '/health/identity') return false
    response.end(JSON.stringify({ ...expected, checkoutId: 'wrong-build' }))
    return true
  })
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 1100 }),
    /different database installation or release/)
  assert.deepEqual(f.requests, ['/health/identity'])
})

test('a release identity that changes during dashboard loading also fails immediately', async t => {
  let servedDashboard = false
  const f = await fixture(t, (request, response) => {
    if (request.url === '/workspaces') servedDashboard = true
    if (request.url !== '/health/identity' || !servedDashboard) return false
    response.end(JSON.stringify({ ...expected, checkoutId: 'wrong-build' }))
    return true
  })
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 1100 }),
    /different database installation or release/)
  assert.deepEqual(f.requests, ['/health/identity', '/health/ready', '/workspaces', '/health/identity'])
})

test('a failed service start interrupts network retries and preserves the start error', async t => {
  const f = await fixture(t, request => { request.socket.destroy(); return true })
  const failure = new Error('systemctl start: unit failed/exited')
  let rolledBack = false
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 5000,
    start: async () => { await delay(50); throw failure },
    rollback: error => { assert.equal(error, failure); rolledBack = true } }), error => error === failure)
  assert.equal(rolledBack, true)
  assert.equal(f.requests.length, 1)
})

for (const [active, sub] of [['failed', 'failed'], ['inactive', 'dead'], ['activating', 'auto-restart']]) {
  test(`a unit that exits into ${active}/${sub} stops readiness retries`, async t => {
    const f = await fixture(t, request => { request.socket.destroy(); return true })
    let checks = 0
    let rolledBack = false
    await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 2000,
      checkService: () => checkProductionService(async () => ({ stdout: ++checks === 1
        ? 'ActiveState=active\nSubState=running\n' : `ActiveState=${active}\nSubState=${sub}\n` })),
      rollback: () => { rolledBack = true }, smoke: () => assert.fail('Unit exited') }), /unit failed\/exited/)
    assert.equal(rolledBack, true)
    assert.equal(checks, 2)
    assert.equal(f.requests.length, 1)
  })
}

test('an ExecStartPost health check accepts an activating service', async () => {
  await checkProductionService(async () => ({ stdout: 'ActiveState=activating\nSubState=start-post\n' }))
})

test('a failed service inspection is not retried as a network failure', async t => {
  const f = await fixture(t)
  const failure = new Error('systemctl show failed')
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 2000,
    checkService: () => { throw failure } }), error => error === failure)
  assert.deepEqual(f.requests, [])
})

test('a request timeout cannot extend the readiness deadline', async t => {
  const f = await fixture(t, () => true)
  const started = performance.now()
  await assert.rejects(waitForProductionReady({ origin: f.origin, expected, timeoutMs: 100 }),
    /readiness timed out.*aborted.*journalctl/i)
  assert.ok(performance.now() - started < 1000, 'The two-second request limit must respect the shorter readiness budget')
})
