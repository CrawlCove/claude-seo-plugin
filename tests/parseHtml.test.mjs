import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decodeEntities, parseHtml } from '../server/crawler/parseHtml.mjs'

describe('parseHtml', () => {
  it('extracts title, meta description, h1 count, canonical, and robots meta', () => {
    const html = `<html><head>
      <title>  Fresh Bread | Acme  </title>
      <meta name="Description" content="Baked fresh every day.">
      <link rel="Canonical" href="/bread">
      <meta name="robots" content="NOINDEX, follow">
    </head><body><h1>One</h1><h1>Two</h1></body></html>`
    const parsed = parseHtml(html, 'https://acme.test/bread/')
    assert.equal(parsed.title, 'Fresh Bread | Acme')
    assert.equal(parsed.metaDescription, 'Baked fresh every day.')
    assert.equal(parsed.h1Count, 2)
    assert.equal(parsed.canonical, 'https://acme.test/bread')
    assert.equal(parsed.robotsMeta, 'noindex, follow')
  })

  it('returns null for absent fields rather than throwing', () => {
    const parsed = parseHtml('<html><body>No head at all</body></html>', 'https://acme.test/')
    assert.equal(parsed.title, null)
    assert.equal(parsed.metaDescription, null)
    assert.equal(parsed.canonical, null)
    assert.equal(parsed.robotsMeta, null)
    assert.equal(parsed.h1Count, 0)
    assert.deepEqual(parsed.links, [])
  })

  it('resolves relative links to absolute URLs, dedupes, and drops anchors/mailto/tel', () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="/about">About again</a>
      <a href="contact.html">Contact</a>
      <a href="#section">Jump</a>
      <a href="mailto:hi@acme.test">Email</a>
      <a href="tel:+441234567">Call</a>
      <a href="https://other.test/">Other site</a>
    </body></html>`
    const parsed = parseHtml(html, 'https://acme.test/menu/')
    assert.deepEqual(
      parsed.links.sort(),
      ['https://acme.test/about', 'https://acme.test/menu/contact.html', 'https://other.test/'].sort()
    )
  })

  it('strips the hash fragment from resolved links', () => {
    const parsed = parseHtml('<a href="/page#section">x</a>', 'https://acme.test/')
    assert.deepEqual(parsed.links, ['https://acme.test/page'])
  })

  it('reads single-quoted, unquoted and oddly spaced attributes, in any case', () => {
    const html = `<HEAD><META CONTENT='Quoted the other way' NAME=description>
      <LINK HREF = "/c"   REL = canonical ><meta content="index,follow" name='ROBOTS'/></HEAD>
      <A class=x HREF=/plain>one</A><a
        href="/multi-line"
      >two</a><a data-href="/not-a-link">three</a><a href>empty</a>`
    const parsed = parseHtml(html, 'https://acme.test/')
    assert.equal(parsed.metaDescription, 'Quoted the other way')
    assert.equal(parsed.canonical, 'https://acme.test/c')
    assert.equal(parsed.robotsMeta, 'index,follow')
    assert.deepEqual(parsed.links, ['https://acme.test/plain', 'https://acme.test/multi-line'])
  })

  it('decodes character references in the title, description and link URLs', () => {
    const html = `<title>Fish &amp; Chips &#8211; Menu &#x2603; &copy; Acme</title>
      <meta name="description" content="Salt &amp; vinegar, &quot;proper&quot; chips">
      <a href="/search?a=1&amp;b=2">s</a><a href="/q?x=1&copy=2">raw</a>`
    const parsed = parseHtml(html, 'https://acme.test/')
    assert.equal(parsed.title, 'Fish & Chips – Menu ☃ © Acme')
    assert.equal(parsed.metaDescription, 'Salt & vinegar, "proper" chips')
    assert.deepEqual(parsed.links, ['https://acme.test/search?a=1&b=2', 'https://acme.test/q?x=1&copy=2'])
    assert.equal(decodeEntities('&unknown; &#0; &lt;b&gt;'), '&unknown; � <b>')
    assert.equal(decodeEntities('WordPress &rsaquo; Error &pound;5 caf&eacute; &Omega;'), 'WordPress \u203a Error \u00a35 caf\u00e9 \u03a9')
  })

  it('ignores markup inside comments, scripts, styles and textareas', () => {
    const html = `<head><!-- <title>Commented out</title> <a href="/in-comment">x</a> -->
      <script>document.write('<h1>From script</h1><a href="/in-script">x</a>'); if (a < b) {}</script>
      <style>a[href="/in-style"] > h1 { color: red }</style>
      <title>Real title</title></head>
      <body><h1>Only one</h1><textarea><a href="/in-textarea">x</a><h1>no</h1></textarea>
      <noscript><a href="/in-noscript">enable JavaScript</a><h1>no</h1></noscript>
      <a href="/real">real</a> 1 < 2 and <3 <a href="/after-bare-lt">ok</a></body>`
    const parsed = parseHtml(html, 'https://acme.test/')
    assert.equal(parsed.title, 'Real title')
    assert.equal(parsed.h1Count, 1)
    assert.deepEqual(parsed.links, ['https://acme.test/real', 'https://acme.test/after-bare-lt'])
  })

  it('takes the first title, description, robots and canonical, and does not treat an svg title as the page title', () => {
    const html = `<body><svg><title>Icon tooltip</title></svg>
      <meta name="description" content="First"><meta name="description" content="Second">
      <link rel="canonical" href="/one"><link rel="canonical" href="/two">
      <link rel="stylesheet" href="/s.css"><link rel="alternate" href="/feed">
      <title>Page title</title><title>Second title</title></body>`
    const parsed = parseHtml(html, 'https://acme.test/')
    assert.equal(parsed.title, 'Page title')
    assert.equal(parsed.metaDescription, 'First')
    assert.equal(parsed.canonical, 'https://acme.test/one')
  })

  it('survives truncated and malformed markup', () => {
    assert.equal(parseHtml('<title>Never closed', 'https://acme.test/').title, 'Never closed')
    assert.deepEqual(parseHtml('<a href="/x', 'https://acme.test/').links, ['https://acme.test/x'])
    assert.deepEqual(parseHtml('<a href="http://[bad">x</a><a href="  /ok  ">y</a><', 'https://acme.test/').links, [
      'https://acme.test/ok'
    ])
    assert.equal(parseHtml('<!-- never closed <h1>x</h1>', 'https://acme.test/').h1Count, 0)
    assert.equal(parseHtml('', 'https://acme.test/').title, null)
  })
})
