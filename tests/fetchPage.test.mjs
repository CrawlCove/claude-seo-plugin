import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { fetchPage } from '../server/crawler/fetchPage.mjs'
import { FixtureServer } from './fixtureServer.mjs'

const OPTS = { userAgent: 'test', timeoutMs: 5000 }

describe('fetchPage', () => {
  let server

  afterEach(async () => {
    await server.close()
  })

  it('returns the body and status for a plain 200 page', async () => {
    server = new FixtureServer({ '/': { status: 200, body: '<html><body>hi</body></html>' } })
    const base = await server.listen()
    const result = await fetchPage(base + '/', OPTS)
    assert.equal(result.statusCode, 200)
    assert.equal(result.redirectHops, 0)
    assert.equal(result.fetchError, null)
    assert.match(result.body, /hi/)
    assert.equal(server.requests[0].userAgent, 'test')
  })

  it('follows redirects and counts hops', async () => {
    server = new FixtureServer({
      '/a': { status: 301, headers: { location: '/b' } },
      '/b': { status: 302, headers: { location: '/c' } },
      '/c': { status: 200, body: 'landed' }
    })
    const base = await server.listen()
    const result = await fetchPage(base + '/a', OPTS)
    assert.equal(result.redirectHops, 2)
    assert.equal(result.finalUrl, base + '/c')
    assert.equal(result.statusCode, 200)
    assert.equal(result.body, 'landed')
  })

  it('reports TOO_MANY_REDIRECTS on a redirect loop instead of hanging', async () => {
    server = new FixtureServer({
      '/loop-a': { status: 302, headers: { location: '/loop-b' } },
      '/loop-b': { status: 302, headers: { location: '/loop-a' } }
    })
    const base = await server.listen()
    const result = await fetchPage(base + '/loop-a', OPTS)
    assert.equal(result.fetchError, 'TOO_MANY_REDIRECTS')
  })

  it('reports a 404 as a completed fetch, not a fetchError', async () => {
    server = new FixtureServer({})
    const base = await server.listen()
    const result = await fetchPage(base + '/missing', OPTS)
    assert.equal(result.statusCode, 404)
    assert.equal(result.fetchError, null)
  })

  it('does not read the body of a non-HTML response', async () => {
    server = new FixtureServer({
      '/data.json': { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
    })
    const base = await server.listen()
    const result = await fetchPage(base + '/data.json', OPTS)
    assert.equal(result.body, null)
    assert.equal(result.contentType, 'application/json')
  })

  it('reports TIMEOUT when the server never responds in time', async () => {
    server = new FixtureServer({ '/slow': { hang: true } })
    const base = await server.listen()
    const result = await fetchPage(base + '/slow', { userAgent: 'test', timeoutMs: 200 })
    assert.equal(result.fetchError, 'TIMEOUT')
    assert.equal(result.statusCode, null)
  })

  it('reports a connection failure as a fetchError with no status', async () => {
    server = new FixtureServer({})
    const base = await server.listen()
    await server.close()
    const result = await fetchPage(base + '/', OPTS)
    assert.notEqual(result.fetchError, null)
    assert.equal(result.statusCode, null)
    server = new FixtureServer({})
    await server.listen()
  })
})
