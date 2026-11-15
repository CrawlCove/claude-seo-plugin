import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { DEFAULT_USER_AGENT } from '../server/crawler/crawl.mjs'
import { isAllowedByRules, loadRobots, matchesPattern, parseRobotsTxt, productToken } from '../server/crawler/robots.mjs'
import { FixtureServer } from './fixtureServer.mjs'

const OPTS = { userAgent: DEFAULT_USER_AGENT, timeoutMs: 2000 }
const TXT = { 'content-type': 'text/plain' }

describe('loadRobots', () => {
  let server

  afterEach(async () => {
    await server.close()
  })

  it('applies Disallow rules from the * group, longest match wins', async () => {
    server = new FixtureServer({
      '/robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /private/\nAllow: /private/public-page\n' }
    })
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'parsed')
    assert.equal(rules.isAllowed(base + '/'), true)
    assert.equal(rules.isAllowed(base + '/private/secret'), false)
    assert.equal(rules.isAllowed(base + '/private/public-page'), true)
  })

  it('prefers a group addressed to crawlcove-cli over the * group', async () => {
    server = new FixtureServer({
      '/robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /\n\nUser-agent: crawlcove-cli\nDisallow: /admin/\n' }
    })
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.isAllowed(base + '/'), true)
    assert.equal(rules.isAllowed(base + '/admin/users'), false)
  })

  it('treats a 404 robots.txt as allow-all', async () => {
    server = new FixtureServer({})
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'not-found-allow-all')
    assert.equal(rules.status, 404)
    assert.equal(rules.isAllowed(base + '/anything'), true)
  })

  it('treats a 5xx robots.txt as disallow-all', async () => {
    server = new FixtureServer({ '/robots.txt': { status: 503, body: 'down' } })
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'server-error-disallow-all')
    assert.equal(rules.isAllowed(base + '/'), false)
  })

  it('treats an empty 200 robots.txt as allow-all', async () => {
    server = new FixtureServer({ '/robots.txt': { headers: TXT, body: '\n' } })
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'no-rules-allow-all')
    assert.equal(rules.isAllowed(base + '/'), true)
  })

  it('follows a redirect to the real robots.txt', async () => {
    server = new FixtureServer({
      '/robots.txt': { status: 301, headers: { location: '/real-robots.txt' } },
      '/real-robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /x\n' }
    })
    const base = await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'parsed')
    assert.equal(rules.isAllowed(base + '/x'), false)
  })

  it('treats an unreachable origin as disallow-all', async () => {
    server = new FixtureServer({})
    const base = await server.listen()
    await server.close()
    server = new FixtureServer({}) // so afterEach has something to close
    await server.listen()
    const rules = await loadRobots(base, OPTS)
    assert.equal(rules.source, 'fetch-error-disallow-all')
    assert.equal(rules.isAllowed(base + '/'), false)
  })
})

describe('robots.txt rules', () => {
  const allowed = (txt, path, ua = DEFAULT_USER_AGENT) => isAllowedByRules(parseRobotsTxt(txt), 'https://acme.test' + path, ua)

  it('matches the product token before the slash, case-insensitively', () => {
    assert.equal(productToken('Crawlcove-CLI/1.1.4 (+https://crawlcove.com/)'), 'crawlcove-cli')
    assert.equal(productToken('*'), '*')
    assert.equal(allowed('User-agent: CrawlCove-CLI\nDisallow: /a\n', '/a'), false)
    assert.equal(allowed('User-agent: otherbot\nDisallow: /\n', '/a'), true)
  })

  it('supports * wildcards and a $ end anchor', () => {
    assert.equal(matchesPattern('/*.pdf$', '/files/a.pdf'), true)
    assert.equal(matchesPattern('/*.pdf$', '/files/a.pdf?x=1'), false)
    assert.equal(matchesPattern('/shop/*/reviews', '/shop/red-shoes/reviews/2'), true)
    assert.equal(matchesPattern('/shop/*/reviews', '/shop/reviews'), false)
    assert.equal(matchesPattern('/a$b', '/a$b/c'), true) // $ is only special at the end
    assert.equal(matchesPattern('*', '/anything'), true)
    assert.equal(allowed('User-agent: *\nDisallow: /*?sort=\n', '/list?sort=price'), false)
    assert.equal(allowed('User-agent: *\nDisallow: /*?sort=\n', '/list'), true)
  })

  it('lets Allow win a tie and the longer rule win otherwise', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /page\nAllow: /page\n', '/page'), true)
    assert.equal(allowed('User-agent: *\nAllow: /\nDisallow: /private\n', '/private/x'), false)
  })

  it('shares rules across stacked User-agent lines and merges a group named twice', () => {
    const txt = 'User-agent: a\nUser-agent: crawlcove-cli\nDisallow: /one\n\nUser-agent: crawlcove-cli\nDisallow: /two\n'
    assert.equal(allowed(txt, '/one'), false)
    assert.equal(allowed(txt, '/two'), false)
    assert.equal(allowed(txt, '/three'), true)
  })

  it('reads comments, CRLF, an empty Disallow and unknown fields without tripping', () => {
    const txt = '# hello\r\nUser-agent: * # everyone\r\nCrawl-delay: 5\r\nDisallow:\r\nSitemap: https://acme.test/s.xml\r\nDisallow: /tmp # scratch\r\n'
    assert.equal(allowed(txt, '/'), true)
    assert.equal(allowed(txt, '/tmp/x'), false)
    // A named group with an empty Disallow allows everything and does not fall back to *.
    assert.equal(allowed('User-agent: *\nDisallow: /\n\nUser-agent: crawlcove-cli\nDisallow:\n', '/x'), true)
  })

  it('compares percent-encoded paths consistently and includes the query string', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /caf%c3%a9\n', '/caf%C3%A9/menu'), false)
    assert.equal(allowed('User-agent: *\nDisallow: /café\n', '/caf%C3%A9'), false)
    assert.equal(allowed('User-agent: *\nDisallow: /search?q=\n', '/search?q=shoes'), false)
  })

  it('does not blow up on a pattern built to backtrack', () => {
    const started = Date.now()
    assert.equal(matchesPattern('/' + '*a'.repeat(40) + 'b$', '/' + 'a'.repeat(2000)), false)
    assert.ok(Date.now() - started < 2000)
  })
})
