import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SeedBlockedByRobotsError } from '../server/crawler/crawl.mjs'
import { ISSUE_TYPES } from '../server/dataset.mjs'
import { createLineReader, handleMessage, RpcError, serveStdio, SUPPORTED_PROTOCOL_VERSIONS } from '../server/protocol.mjs'
import { createServerSpec, MAX_LIVE_PAGES, MAX_RESPONSE_CHARS } from '../server/tools.mjs'

const cliFixturePath = fileURLToPath(new URL('./fixtures/cli-result.json', import.meta.url))
const desktopFixturePath = fileURLToPath(new URL('./fixtures/desktop-export.json', import.meta.url))
const cliFixture = JSON.parse(readFileSync(cliFixturePath, 'utf8'))

const textOf = (r) => r.content.map((c) => c.text ?? '').join('\n')
const sizeOf = (r) => textOf(r).length + JSON.stringify(r.structuredContent ?? '').length

/** A crawl result with `n` pages, each missing its title, description and H1. */
function bigCrawl(n, extra = {}) {
  const pages = Array.from({ length: n }, (_, i) => ({
    ...cliFixture.pages[1],
    url: `https://big.test/section-${i % 4}/page-${String(i).padStart(4, '0')}-${'x'.repeat(60)}`,
    finalUrl: `https://big.test/section-${i % 4}/page-${String(i).padStart(4, '0')}-${'x'.repeat(60)}`,
    brokenInternalLinks: []
  }))
  return { seedUrl: 'https://big.test/', pages, truncated: false, robotsBlocked: [], ...extra }
}

describe('the crawlcove tools', () => {
  let spec
  let crawlCalls
  let nextId
  let crawlResult

  beforeEach(() => {
    crawlCalls = []
    nextId = 1
    crawlResult = (url) => ({ ...cliFixture, seedUrl: url })
    ;({ spec } = createServerSpec({
      crawl: async (url, opts) => {
        crawlCalls.push({ url, maxPages: opts.maxPages, ignoreRobots: opts.ignoreRobots, userAgent: opts.userAgent })
        return crawlResult(url)
      },
      now: () => new Date('2026-09-29T01:00:00.000Z')
    }))
  })

  const rpc = (method, params) => handleMessage(spec, JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }))
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result

  it('advertises the six tools, each with a title, a description, an object schema and read-only annotations', async () => {
    const { tools } = (await rpc('tools/list')).result
    assert.deepEqual(tools.map((t) => t.name).sort(), ['crawl_site', 'get_issues', 'get_page', 'list_broken_links', 'list_pages', 'load_export'])
    for (const tool of tools) {
      assert.ok(tool.title.length > 0, tool.name)
      assert.ok(tool.description.length > 80, tool.name)
      assert.equal(tool.inputSchema.type, 'object', tool.name)
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
      assert.equal(tool.annotations.readOnlyHint, true, tool.name)
      assert.equal(tool.annotations.destructiveHint, false, tool.name)
      for (const required of tool.inputSchema.required ?? []) assert.ok(required in tool.inputSchema.properties)
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    assert.equal(byName.crawl_site.annotations.openWorldHint, true)
    assert.equal(byName.get_issues.annotations.openWorldHint, false)
    assert.deepEqual(byName.get_issues.inputSchema.properties.type.enum, ISSUE_TYPES)
    assert.equal(byName.crawl_site.inputSchema.properties.maxPages.maximum, 200)
  })

  it('query tools explain what to do when nothing is loaded', async () => {
    for (const name of ['get_issues', 'list_broken_links', 'list_pages']) {
      const r = await call(name)
      assert.equal(r.isError, true)
      assert.match(textOf(r), /No crawl data loaded yet/)
    }
    assert.match(textOf(await call('get_page', { url: 'https://acme.test/' })), /No crawl data loaded yet/)
  })

  it('crawl_site uses the default page cap, records the dataset, and reports issue counts', async () => {
    const r = await call('crawl_site', { url: 'https://acme.test/' })
    assert.equal(r.isError, undefined)
    assert.equal(crawlCalls.length, 1)
    assert.deepEqual(
      { url: crawlCalls[0].url, maxPages: crawlCalls[0].maxPages, ignoreRobots: crawlCalls[0].ignoreRobots },
      { url: 'https://acme.test/', maxPages: 50, ignoreRobots: false }
    )
    assert.match(crawlCalls[0].userAgent, /^crawlcove-cli\//)
    assert.match(textOf(r), /live crawl of https:\/\/acme.test\/: 6 pages, 11 issues/)
    assert.match(textOf(r), /Skipped per robots.txt \(1\):\n- https:\/\/acme.test\/private/)
    assert.equal(r.structuredContent.pageCount, 6)
    assert.equal(r.structuredContent.robotsBlocked, 1)
    assert.equal(r.structuredContent.issueCounts['duplicate-title'], 4)
  })

  it('crawl_site normalises the start URL so the home page is not crawled twice', async () => {
    const r = await call('crawl_site', { url: 'https://Acme.test#top' })
    assert.equal(crawlCalls[0].url, 'https://acme.test/')
    assert.match(textOf(r), /live crawl of https:\/\/acme.test\/: 6 pages/)
  })

  it('crawl_site rejects bad arguments before anything is fetched', async () => {
    const bad = [
      { url: 'not a url' },
      { url: 'ftp://acme.test/' },
      { url: 'file:///etc/passwd' },
      {},
      { url: 'https://acme.test/', maxPages: MAX_LIVE_PAGES + 1 },
      { url: 'https://acme.test/', maxPages: 0 },
      { url: 'https://acme.test/', maxPages: 2.5 },
      { url: 'https://acme.test/', maxPages: '10' },
      { url: 'https://acme.test/', ignoreRobots: 'yes' },
      { url: 'https://acme.test/', depth: 3 }
    ]
    for (const args of bad) {
      const r = await call('crawl_site', args)
      assert.equal(r.isError, true, JSON.stringify(args))
      assert.match(textOf(r), /Invalid arguments for crawl_site/)
    }
    assert.deepEqual(crawlCalls, [])
    assert.match(textOf(await call('get_issues', { type: 'nope' })), /type must be one of: broken-page/)
  })

  it('crawl_site passes maxPages and ignoreRobots through, and says how to see more when the cap cut it short', async () => {
    crawlResult = (url) => ({ ...cliFixture, seedUrl: url, truncated: true })
    const small = await call('crawl_site', { url: 'https://acme.test/', maxPages: 6, ignoreRobots: true })
    assert.deepEqual([crawlCalls[0].maxPages, crawlCalls[0].ignoreRobots], [6, true])
    assert.match(textOf(small), /Raise maxPages \(max 200\)/)
    assert.doesNotMatch(textOf(small), /desktop app/)
    const full = await call('crawl_site', { url: 'https://acme.test/', maxPages: 200 })
    assert.match(textOf(full), /200-page cap/)
    assert.match(textOf(full), /Crawl Cove desktop app .*load_export/)
    assert.equal(full.structuredContent.truncated, true)
  })

  it('crawl_site reports a robots.txt block and any other failure as a tool error, and keeps the previous dataset', async () => {
    await call('crawl_site', { url: 'https://acme.test/' })
    crawlResult = (url) => {
      throw new SeedBlockedByRobotsError(url)
    }
    const blocked = await call('crawl_site', { url: 'https://closed.test/' })
    assert.equal(blocked.isError, true)
    assert.match(textOf(blocked), /robots.txt disallows https:\/\/closed.test\/ .*ignoreRobots: true/)
    crawlResult = () => {
      throw new Error('boom')
    }
    const failed = await call('crawl_site', { url: 'https://closed.test/' })
    assert.equal(failed.isError, true)
    assert.match(textOf(failed), /Crawl failed: boom/)
    assert.match(textOf(await call('list_pages')), /6 of 6 pages match/)
  })

  it('load_export reads a crawlcove-cli file and a desktop export, then the query tools answer from it', async () => {
    const loaded = await call('load_export', { path: cliFixturePath })
    assert.match(textOf(loaded), /crawlcove-cli result .*cli-result.json: 6 pages/)

    const issues = await call('get_issues', { type: 'missing-title' })
    assert.match(textOf(issues), /1 missing-title issue\(s\)/)
    assert.match(textOf(issues), /- \[missing-title\] https:\/\/acme.test\/about: no <title>/)
    assert.equal(issues.structuredContent.total, 1)

    const all = await call('get_issues')
    assert.match(textOf(all), /11 issue\(s\) across 8 types in 6 pages/)
    assert.match(textOf(all), /- duplicate-title: 4/)
    assert.equal(all.structuredContent.issues.length, 11)

    const limited = await call('get_issues', { limit: 3 })
    assert.equal(limited.structuredContent.issues.length, 3)
    assert.match(textOf(limited), /…and 8 more\. Raise limit, or narrow with type\./)

    const page = await call('get_page', { url: 'acme.test/about' })
    assert.match(textOf(page), /Title: \(none\)/)
    assert.match(textOf(page), /Issues: missing-title, missing-meta-description, missing-h1, missing-canonical/)
    assert.equal(page.structuredContent.page.url, 'https://acme.test/about')

    const links = await call('list_broken_links')
    assert.match(textOf(links), /1 broken internal link\(s\)/)
    assert.match(textOf(links), /https:\/\/acme.test\/ → https:\/\/acme.test\/missing \(HTTP 404\)/)
    assert.equal(links.structuredContent.hasLinkGraph, true)

    const desktop = await call('load_export', { path: desktopFixturePath })
    assert.match(textOf(desktop), /Crawl Cove desktop export .*: 7 pages/)
    assert.equal(desktop.structuredContent.source, 'desktop-export')
    const noGraph = await call('list_broken_links')
    assert.match(textOf(noGraph), /no link graph/)
    assert.equal(noGraph.structuredContent.hasLinkGraph, false)
    const depth = await call('get_page', { url: 'https://acmebakery.example/' })
    assert.match(textOf(depth), /Depth: 0\nWord count: 480/)
  })

  it('load_export fails cleanly on a missing file, a directory, or the wrong shape', async () => {
    const missing = await call('load_export', { path: '/nonexistent/file.json' })
    assert.equal(missing.isError, true)
    assert.match(textOf(missing), /Could not read/)
    const dir = await call('load_export', { path: fileURLToPath(new URL('./fixtures', import.meta.url)) })
    assert.equal(dir.isError, true)
    assert.match(textOf(dir), /not a file/)
    const { spec: other } = createServerSpec({ readFile: () => '{"hello":"world"}' })
    const wrong = await other.callTool('load_export', { path: 'x.json' })
    assert.equal(wrong.isError, true)
    assert.match(textOf(wrong), /neither a Crawl Cove desktop export/)
    assert.equal((await call('load_export', {})).isError, true)
  })

  it('get_page reports an unknown URL and list_pages filters', async () => {
    await call('load_export', { path: cliFixturePath })
    const nope = await call('get_page', { url: 'https://acme.test/zzz' })
    assert.equal(nope.isError, true)
    assert.match(textOf(nope), /not in the active dataset \(6 pages\)/)
    const pages = await call('list_pages', { status: 404 })
    assert.match(textOf(pages), /1 of 6 pages match/)
    assert.equal(pages.structuredContent.total, 1)
    const hidden = await call('list_pages', { indexable: false })
    assert.equal(hidden.structuredContent.total, 2)
    assert.match(textOf(hidden), /\[not indexable\]/)
    assert.equal((await call('list_pages', { urlContains: 'blog' })).structuredContent.total, 1)
    assert.equal((await call('list_pages', { urlContains: 'blog', status: 404 })).structuredContent.total, 0)
  })

  it('caps every list answer near 25,000 characters and says how to narrow it', async () => {
    crawlResult = () => bigCrawl(200)
    await call('crawl_site', { url: 'https://big.test/', maxPages: 200 })

    const issues = await call('get_issues', { limit: 500 })
    assert.ok(sizeOf(issues) <= MAX_RESPONSE_CHARS, `get_issues answered with ${sizeOf(issues)} chars`)
    assert.equal(issues.structuredContent.total, 800)
    const shown = issues.structuredContent.issues.length
    assert.ok(shown > 20 && shown < 500)
    assert.match(textOf(issues), new RegExp(`…and ${800 - shown} more, left out to keep this answer under 25000 characters\\. Narrow with type\\.`))
    assert.equal(textOf(issues).split('\n').filter((l) => l.startsWith('- [')).length, shown)

    const pages = await call('list_pages', { limit: 1000 })
    assert.ok(sizeOf(pages) <= MAX_RESPONSE_CHARS)
    assert.equal(pages.structuredContent.total, 200)
    assert.match(textOf(pages), /…and \d+ more, left out .* Narrow with urlContains, status or indexable\./)

    const section = await call('list_pages', { urlContains: '/section-1/', limit: 1000 })
    assert.equal(section.structuredContent.pages.length, 50)
    assert.doesNotMatch(textOf(section), /more/)
  })

  it('caps list_broken_links and a page with very many broken links', async () => {
    const result = bigCrawl(120)
    const targets = result.pages.slice(1).map((p) => p.url)
    result.pages = result.pages.map((p, i) => (i === 0 ? { ...p, brokenInternalLinks: targets } : { ...p, statusCode: 404, brokenInternalLinks: targets }))
    crawlResult = () => result
    await call('crawl_site', { url: 'https://big.test/' })
    const links = await call('list_broken_links', { limit: 500 })
    assert.ok(sizeOf(links) <= MAX_RESPONSE_CHARS)
    assert.equal(links.structuredContent.total, 120 * 119)
    assert.match(textOf(links), /…and \d+ more, left out/)
    const page = await call('get_page', { url: result.pages[0].url })
    assert.ok(sizeOf(page) <= MAX_RESPONSE_CHARS)
    assert.equal(page.structuredContent.page.brokenInternalLinks.length, 50)
    assert.equal(page.structuredContent.page.brokenInternalLinksTotal, 119)
    assert.match(textOf(page), /Broken links out \(119\): .*…and 69 more/)
  })
})

describe('the JSON-RPC layer', () => {
  const { spec } = createServerSpec({ crawl: async () => cliFixture })
  const send = (obj) => handleMessage(spec, typeof obj === 'string' ? obj : JSON.stringify(obj))

  it('answers initialize with the client version when supported, else the newest it knows', async () => {
    const res = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    assert.equal(res.result.protocolVersion, '2025-03-26')
    assert.deepEqual(res.result.capabilities, { tools: {} })
    assert.deepEqual(res.result.serverInfo, { name: 'crawlcove', version: '1.0.0' })
    assert.match(res.result.instructions, /crawl_site/)
    const future = await send({ jsonrpc: '2.0', id: 'abc', method: 'initialize', params: { protocolVersion: '2099-01-01' } })
    assert.equal(future.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0])
    assert.equal(future.id, 'abc')
  })

  it('answers ping, and owes nothing to notifications or stray responses', async () => {
    assert.deepEqual(await send({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} })
    assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
    assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null)
    assert.equal(await send({ jsonrpc: '2.0', id: 9, result: {} }), null)
  })

  it('uses the standard error codes', async () => {
    assert.equal((await send('{not json')).error.code, RpcError.ParseError)
    assert.equal((await send('{not json')).id, null)
    assert.equal((await send('[1,2]')).error.code, RpcError.InvalidRequest)
    assert.equal((await send({ id: 1, method: 'ping' })).error.code, RpcError.InvalidRequest)
    assert.equal((await send({ jsonrpc: '2.0', id: 1 })).error.code, RpcError.InvalidRequest)
    assert.equal((await send({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, RpcError.InvalidRequest)
    const unknown = await send({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
    assert.deepEqual([unknown.error.code, unknown.id], [RpcError.MethodNotFound, 3])
    assert.equal((await send({ jsonrpc: '2.0', id: 4, method: 'tools/call' })).error.code, RpcError.InvalidParams)
    assert.equal((await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_issues', arguments: [] } })).error.code, RpcError.InvalidParams)
    const noTool = await send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_site' } })
    assert.equal(noTool.error.code, RpcError.InvalidParams)
    assert.match(noTool.error.message, /Unknown tool: delete_site/)
  })

  it('a failing tool is a result with isError, not a protocol error', async () => {
    const res = await send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_page', arguments: {} } })
    assert.equal(res.error, undefined)
    assert.equal(res.result.isError, true)
    const thrown = await handleMessage(
      { name: 'x', version: '0', tools: [], callTool: () => { throw new Error('kaboom') } },
      JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'any' } })
    )
    assert.deepEqual(thrown.result, { content: [{ type: 'text', text: 'kaboom' }], isError: true })
  })

  it('reads lines split across chunks, several per chunk, CRLF, and a split UTF-8 character', () => {
    const lines = []
    const reader = createLineReader((l) => lines.push(l))
    const bytes = Buffer.from('{"a":"é"}\r\n{"b":2}\n\n{"c":3}')
    reader.push(bytes.subarray(0, 7)) // cuts the two-byte é in half
    reader.push(bytes.subarray(7))
    reader.end()
    assert.deepEqual(lines, ['{"a":"é"}', '{"b":2}', '{"c":3}'])
  })

  it('serves a stream in request order and resolves when the input ends', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks = []
    output.on('data', (c) => chunks.push(c))
    const done = serveStdio(spec, input, output)
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crawl_site","arguments":{"url":"https://acme.test/"}}}\n')
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\noops\n')
    input.end('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_pages"}}')
    await done
    const replies = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(replies.map((r) => r.id), [1, 2, null, 3])
    assert.equal(replies[2].error.code, RpcError.ParseError)
    assert.match(replies[3].result.content[0].text, /6 of 6 pages match/)
  })
})
