import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { FixtureServer } from './fixtureServer.mjs'

const CLI = fileURLToPath(new URL('../server/cli.mjs', import.meta.url))
const desktopFixturePath = fileURLToPath(new URL('./fixtures/desktop-export.json', import.meta.url))

/** Spawn `node server/cli.mjs` and talk newline-delimited JSON-RPC to it, keeping every raw stdout line. */
function startServer() {
  const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdoutLines = []
  const waiting = new Map()
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      stdoutLines.push(line)
      try {
        const msg = JSON.parse(line)
        waiting.get(msg.id)?.(msg)
        waiting.delete(msg.id)
      } catch {
        // left in stdoutLines for the test to fail on
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  let nextId = 1
  return {
    stdoutLines,
    exited,
    stderr: () => stderr,
    trailing: () => buffer,
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    request(method, params) {
      const id = nextId++
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 15s; stderr: ${stderr}`)), 15_000)
        waiting.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return reply
    },
    raw(line) {
      child.stdin.write(line + '\n')
    },
    close() {
      child.stdin.end()
      return exited
    },
    kill() {
      child.kill()
    }
  }
}

describe('node server/cli.mjs over stdio', () => {
  let site
  let base
  let server

  before(async () => {
    site = new FixtureServer({
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' },
      '/': {
        body:
          '<html><head><title>Home &amp; garden</title><meta name="description" content="The home page."><link rel="canonical" href="/"></head>' +
          '<body><h1>Home</h1><a href="/about">About</a><a href="/gone">Gone</a><a href="/old">Old</a><a href="/private">Private</a>' +
          '<a href="https://elsewhere.test/">Away</a></body></html>'
      },
      '/about': { body: '<html><head><title>About</title></head><body><a href="/gone">Gone again</a><a href="/">Home</a></body></html>' },
      '/old': { status: 301, headers: { location: '/older' } },
      '/older': { status: 302, headers: { location: '/about' } },
      '/private': { body: '<html><head><title>Private</title></head><body></body></html>' }
      // '/gone' is not registered: 404
    })
    base = await site.listen()
    server = startServer()
  })

  after(async () => {
    server.kill()
    await site.close()
  })

  it('initializes, lists tools, crawls a local site, and answers get_issues and list_broken_links', async () => {
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'protocol-test', version: '0.0.0' }
    })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'crawlcove')
    assert.deepEqual(init.result.capabilities, { tools: {} })
    server.notify('notifications/initialized')

    assert.deepEqual((await server.request('ping')).result, {})

    const { tools } = (await server.request('tools/list')).result
    assert.deepEqual(tools.map((t) => t.name), ['crawl_site', 'load_export', 'get_issues', 'get_page', 'list_broken_links', 'list_pages'])

    const crawl = (await server.request('tools/call', { name: 'crawl_site', arguments: { url: base, maxPages: 20 } })).result
    assert.equal(crawl.isError, undefined, crawl.content[0].text)
    // The start URL was given without its trailing slash; "/" must still be crawled once, not twice.
    assert.equal(site.requests.filter((r) => r.url === '/').length, 1)
    assert.equal(crawl.structuredContent.pageCount, 4) // "/", "/about", "/gone", "/old"
    assert.equal(crawl.structuredContent.truncated, false)
    assert.equal(crawl.structuredContent.robotsBlocked, 1)
    assert.equal(site.requests.some((r) => r.url === '/private'), false)
    assert.ok(site.requests.every((r) => /^crawlcove-cli\//.test(r.userAgent)))

    const issues = (await server.request('tools/call', { name: 'get_issues', arguments: {} })).result
    assert.deepEqual(
      Object.fromEntries(Object.entries(issues.structuredContent.counts).filter(([, n]) => n > 0)),
      {
        'broken-page': 1,
        // no duplicate-title: "/old" redirects to "/about", so it is the same page, not a second one
        'missing-meta-description': 2,
        'missing-h1': 2,
        'redirect-chain': 1,
        'missing-canonical': 2
      }
    )
    assert.match(issues.content[0].text, new RegExp(`- \\[broken-page\\] ${base}/gone: HTTP 404`))
    assert.match(issues.content[0].text, new RegExp(`- \\[redirect-chain\\] ${base}/old: 2 hops → ${base}/about`))

    const links = (await server.request('tools/call', { name: 'list_broken_links', arguments: {} })).result
    assert.deepEqual(links.structuredContent.brokenLinks, [
      { source: base + '/', target: base + '/gone', detail: 'HTTP 404' },
      { source: base + '/about', target: base + '/gone', detail: 'HTTP 404' },
      { source: base + '/old', target: base + '/gone', detail: 'HTTP 404' }
    ])

    const page = (await server.request('tools/call', { name: 'get_page', arguments: { url: base } })).result
    assert.match(page.content[0].text, /Title: Home & garden \[13 chars\]/)

    const loaded = (await server.request('tools/call', { name: 'load_export', arguments: { path: desktopFixturePath } })).result
    assert.match(loaded.content[0].text, /7 pages/)
  })

  it('answers garbage with a JSON-RPC error and keeps going', async () => {
    server.raw('this is not json')
    const after = await server.request('ping')
    assert.deepEqual(after.result, {})
    const parseErrors = server.stdoutLines.map((l) => JSON.parse(l)).filter((m) => m.error?.code === -32700)
    assert.equal(parseErrors.length, 1)
    const unknown = await server.request('prompts/list')
    assert.equal(unknown.error.code, -32601)
  })

  it('writes only JSON-RPC to stdout, logs to stderr, and exits 0 when stdin closes', async () => {
    const code = await server.close()
    assert.equal(code, 0)
    assert.equal(server.trailing(), '')
    assert.ok(server.stdoutLines.length >= 11)
    for (const line of server.stdoutLines) {
      const msg = JSON.parse(line) // throws on anything that is not JSON
      assert.equal(msg.jsonrpc, '2.0')
      assert.ok('id' in msg)
      assert.ok('result' in msg !== 'error' in msg, 'exactly one of result or error')
    }
    assert.match(server.stderr(), /crawlcove \d+\.\d+\.\d+ ready \(stdio\)/)
  })
})
