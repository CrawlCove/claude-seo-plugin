import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { crawlSite, DEFAULT_CRAWL_OPTIONS, DEFAULT_USER_AGENT, SeedBlockedByRobotsError } from '../server/crawler/crawl.mjs'
import { FixtureServer } from './fixtureServer.mjs'

const NOW = () => new Date('2026-09-24T09:00:00.000Z')
const TXT = { 'content-type': 'text/plain' }

describe('crawlSite', () => {
  let server

  afterEach(async () => {
    await server.close()
  })

  it('follows same-origin links breadth-first and stops discovering new ones past max-pages', async () => {
    server = new FixtureServer({
      '/': { body: '<html><head><title>Home</title></head><body><a href="/about">About</a></body></html>' },
      '/about': { body: '<html><head><title>About</title></head><body><a href="/contact">Contact</a></body></html>' },
      '/contact': { body: '<html><head><title>Contact</title></head><body></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, maxPages: 100, now: NOW })
    assert.equal(result.pageCount, 3)
    assert.equal(result.truncated, false)
    assert.equal(result.crawledAt, '2026-09-24T09:00:00.000Z')
    assert.deepEqual(result.pages.map((p) => p.url), [base + '/', base + '/about', base + '/contact'])
  })

  it('never follows a link to another origin', async () => {
    server = new FixtureServer({
      '/': { body: '<html><body><a href="https://elsewhere.test/page">Away</a></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW })
    assert.equal(result.pageCount, 1)
    assert.equal(result.pages[0].url, base + '/')
  })

  it('caps the crawl at maxPages and reports truncated', async () => {
    server = new FixtureServer({
      '/': { body: '<html><body><a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a></body></html>' },
      '/p1': { body: '<html><body></body></html>' },
      '/p2': { body: '<html><body></body></html>' },
      '/p3': { body: '<html><body></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, maxPages: 2, now: NOW })
    assert.equal(result.pageCount, 2)
    assert.equal(result.truncated, true)
    assert.equal(server.requests.filter((r) => r.url !== '/robots.txt').length, 2)
  })

  it('marks a noindex page indexable=false, and flags links pointing at broken pages', async () => {
    server = new FixtureServer({
      '/': { body: '<html><body><a href="/broken">Broken</a><a href="/noindexed">Noindexed</a></body></html>' },
      '/noindexed': { body: '<html><head><meta name="robots" content="noindex"></head><body></body></html>' }
      // '/broken' deliberately not registered: 404
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW })
    const home = result.pages.find((p) => p.url === base + '/')
    const broken = result.pages.find((p) => p.url === base + '/broken')
    const noindexed = result.pages.find((p) => p.url === base + '/noindexed')

    assert.deepEqual(home.brokenInternalLinks, [base + '/broken'])
    assert.deepEqual(result.summary, { brokenLinks: 2, missingTitles: 3, noindex: 1, redirectChains: 0 })
    assert.equal(broken.statusCode, 404)
    assert.equal(broken.indexable, false)
    assert.equal(noindexed.robotsMeta, 'noindex')
    assert.equal(noindexed.indexable, false)
  })

  it('records redirect hops on a page reached via a redirect', async () => {
    server = new FixtureServer({
      '/': { body: '<html><body><a href="/old">Old</a></body></html>' },
      '/old': { status: 301, headers: { location: '/new' } },
      '/new': { body: '<html><head><title>New</title></head><body></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW })
    const old = result.pages.find((p) => p.url === base + '/old')
    assert.equal(old.redirectHops, 1)
    assert.equal(old.finalUrl, base + '/new')
    assert.equal(old.title, 'New')
  })

  it('never fetches a URL robots.txt disallows, and lists it in robotsBlocked', async () => {
    server = new FixtureServer({
      '/robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /private\n' },
      '/': { body: '<html><body><a href="/private">P</a><a href="/public">Q</a></body></html>' },
      '/public': { body: '<html><head><title>Public</title></head><body></body></html>' },
      '/private': { body: '<html><head><title>Private</title></head><body></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW })
    assert.equal(server.requests.some((r) => r.url === '/private'), false)
    assert.deepEqual(result.pages.map((p) => p.url).sort(), [base + '/', base + '/public'].sort())
    assert.deepEqual(result.robotsBlocked, [base + '/private'])
    assert.equal(result.robotsIgnored, false)
  })

  it('crawls disallowed URLs when ignoreRobots is set, says so, and does not fetch robots.txt', async () => {
    server = new FixtureServer({
      '/robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /\n' },
      '/': { body: '<html><body><a href="/private">P</a></body></html>' },
      '/private': { body: '<html><head><title>Private</title></head><body></body></html>' }
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, ignoreRobots: true, now: NOW })
    assert.equal(result.pageCount, 2)
    assert.equal(result.robotsIgnored, true)
    assert.deepEqual(result.robotsBlocked, [])
    assert.equal(server.requests.some((r) => r.url === '/robots.txt'), false)
  })

  it('throws SeedBlockedByRobotsError instead of crawling when the seed itself is disallowed', async () => {
    server = new FixtureServer({
      '/robots.txt': { headers: TXT, body: 'User-agent: *\nDisallow: /\n' },
      '/': { body: '<html><body></body></html>' }
    })
    const base = await server.listen()
    await assert.rejects(crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW }), SeedBlockedByRobotsError)
    assert.deepEqual(server.requests.map((r) => r.url), ['/robots.txt'])
  })

  it('sends the crawlcove-cli user agent on every request and never more than 4 at once', async () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">${i}</a>`).join('')
    const routes = { '/': { body: `<html><body>${links}</body></html>` } }
    for (let i = 0; i < 12; i++) routes[`/p${i}`] = { body: '<html><body></body></html>' }
    server = new FixtureServer(routes)
    let inFlight = 0
    let peak = 0
    server.server.prependListener('request', (req, res) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      res.on('close', () => (inFlight -= 1))
    })
    const base = await server.listen()
    const result = await crawlSite(base + '/', { ...DEFAULT_CRAWL_OPTIONS, now: NOW })
    assert.equal(result.pageCount, 13)
    assert.ok(peak <= 4, `peak concurrency was ${peak}`)
    assert.match(DEFAULT_USER_AGENT, /^crawlcove-cli\/\d+\.\d+\.\d+ \(\+https:\/\/crawlcove\.com\/open-source\/crawlcove-cli\)$/)
    assert.equal(DEFAULT_CRAWL_OPTIONS.concurrency, 4)
    assert.ok(server.requests.every((r) => r.userAgent === DEFAULT_USER_AGENT))
  })
})
