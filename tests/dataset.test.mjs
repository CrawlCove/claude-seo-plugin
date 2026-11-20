import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { countIssues, detectShape, findIssues, findPage, fromJsonText, listBrokenLinks, listPages } from '../server/dataset.mjs'

const desktopText = readFileSync(new URL('./fixtures/desktop-export.json', import.meta.url), 'utf8')
const cliText = readFileSync(new URL('./fixtures/cli-result.json', import.meta.url), 'utf8')

describe('shape detection and loading', () => {
  it('recognises both supported shapes and rejects anything else', () => {
    assert.equal(detectShape(JSON.parse(desktopText)), 'desktop-export')
    assert.equal(detectShape(JSON.parse(cliText)), 'cli-result')
    assert.equal(detectShape({ pages: [] }), null)
    assert.equal(detectShape('nope'), null)
    assert.throws(() => fromJsonText('{"foo":1}', 'x.json'), /neither a Crawl Cove desktop export/)
    assert.throws(() => fromJsonText('{bad', 'x.json'), /not valid JSON/)
  })

  it('does not echo file contents when the file is not JSON', () => {
    assert.throws(
      () => fromJsonText('secret-token-value', 'x.txt'),
      (err) => !err.message.includes('secret')
    )
  })

  it('maps a desktop export page for page, with no link graph', () => {
    const ds = fromJsonText(desktopText, 'export.json')
    assert.equal(ds.source, 'desktop-export')
    assert.equal(ds.pages.length, 7)
    const home = ds.pages[0]
    assert.equal(home.url, 'https://acmebakery.example/')
    assert.equal(home.brokenInternalLinks, null)
    assert.equal(home.depth, 0)
    assert.equal(home.wordCount, 480)
  })

  it('maps a CLI result and keeps its link graph and robots list', () => {
    const ds = fromJsonText(cliText, 'cli.json')
    assert.equal(ds.source, 'cli-result')
    assert.deepEqual(ds.robotsBlocked, ['https://acme.test/private'])
    assert.deepEqual(ds.pages[0].brokenInternalLinks, ['https://acme.test/missing'])
    assert.equal(ds.pages[0].depth, null)
  })

  it('tolerates a hand-edited file with missing fields and junk entries', () => {
    const ds = fromJsonText(JSON.stringify({ seedUrl: 'https://a.test/', pages: [null, 7, { url: 'https://a.test/' }, { title: 'no url' }] }), 'x')
    assert.equal(ds.pages.length, 1)
    assert.deepEqual(ds.pages[0].brokenInternalLinks, [])
    assert.equal(ds.pages[0].redirectHops, 0)
    assert.deepEqual(findIssues(ds), []) // no status: nothing can be said about the page
    assert.deepEqual(listBrokenLinks(ds), [])
  })
})

describe('issues', () => {
  const ds = fromJsonText(cliText, 'cli.json')

  it('finds every planted issue type once, and skips content checks on broken pages', () => {
    const counts = countIssues(ds)
    assert.equal(counts['broken-page'], 1) // /missing
    assert.equal(counts['missing-title'], 1) // /about only: the 404 is not double-reported
    assert.equal(counts['missing-meta-description'], 1)
    assert.equal(counts['missing-h1'], 1)
    assert.equal(counts['missing-canonical'], 1)
    assert.equal(counts['duplicate-title'], 2) // "/" and "/blog" share the default "A page"; "/hidden" is noindex and "/old" redirected, so neither competes
    assert.equal(counts.noindex, 1)
    assert.equal(counts['redirect-chain'], 1)
    assert.equal(counts['long-title'], 0)
  })

  it('filters by type and orders by ISSUE_TYPES', () => {
    assert.deepEqual(findIssues(ds, 'noindex'), [
      { type: 'noindex', url: 'https://acme.test/hidden', detail: 'robots meta: noindex, nofollow' }
    ])
    assert.equal(findIssues(ds)[0].type, 'broken-page')
  })

  it('flags long titles and long meta descriptions on the desktop export', () => {
    const d = fromJsonText(desktopText, 'export.json')
    const counts = countIssues(d)
    assert.ok(counts['long-title'] >= 1)
    assert.ok(counts['broken-page'] >= 2) // the 404 and the timeout
    assert.ok(findIssues(d, 'broken-page').map((i) => i.detail).includes('HTTP 404'))
  })
})

describe('lookups', () => {
  const ds = fromJsonText(cliText, 'cli.json')

  it('finds a page exactly, without scheme, or without the trailing slash', () => {
    assert.equal(findPage(ds, 'https://acme.test/about')?.url, 'https://acme.test/about')
    assert.equal(findPage(ds, 'acme.test/about/')?.url, 'https://acme.test/about')
    assert.equal(findPage(ds, 'https://acme.test/new')?.url, 'https://acme.test/old') // by final URL
    assert.equal(findPage(ds, 'https://acme.test/nope'), undefined)
  })

  it('lists broken links as source and target with the failure, or null without a link graph', () => {
    assert.deepEqual(listBrokenLinks(ds), [
      { source: 'https://acme.test/', target: 'https://acme.test/missing', detail: 'HTTP 404' }
    ])
    assert.equal(listBrokenLinks(fromJsonText(desktopText, 'x')), null)
  })

  it('filters pages', () => {
    assert.deepEqual(listPages(ds, { status: 404 }).map((p) => p.url), ['https://acme.test/missing'])
    assert.equal(listPages(ds, { indexable: false }).length, 2)
    assert.equal(listPages(ds, { urlContains: 'blog' }).length, 1)
  })
})
