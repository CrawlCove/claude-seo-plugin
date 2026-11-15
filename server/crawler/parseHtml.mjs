/**
 * Parse a page's HTML for the fields the crawler's checks need: title, meta
 * description, H1 count, canonical, robots meta and links.
 *
 * This is a small hand-written tag scanner, not a full HTML parser (the plugin
 * ships with no dependencies). It does what the checks need and tolerates
 * malformed markup: it walks the tags in document order, skips comments and
 * the contents of script/style, reads attributes quoted or unquoted, and
 * decodes character references in the values it returns.
 */

import { NAMED_ENTITY_CODE_POINTS } from './entities.mjs'

/**
 * Elements whose content is text, not markup, up to their own closing tag.
 * <noscript> is in the list because a browser with JavaScript on (and a search
 * engine that renders) never sees its content as elements.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])

/** Decode character references: `&amp;`, `&#38;`, `&#x26;`. An unknown name is left as written. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
      return String.fromCodePoint(code)
    }
    // A named reference needs its semicolon; "&copy=1" in a URL stays as it is.
    if (!whole.endsWith(';')) return whole
    return Object.hasOwn(NAMED_ENTITY_CODE_POINTS, body) ? String.fromCodePoint(NAMED_ENTITY_CODE_POINTS[body]) : whole
  })
}

const WHITESPACE = /[\t\n\f\r ]/

/**
 * Read one tag's attributes starting at `i` (just past the tag name).
 * Returns { attrs, end } where `end` is the index after the closing `>`.
 * The first occurrence of a repeated attribute wins, as in a browser.
 */
function readAttributes(html, i) {
  const attrs = {}
  const n = html.length
  for (;;) {
    while (i < n && (WHITESPACE.test(html[i]) || html[i] === '/')) i++
    if (i >= n) return { attrs, end: n }
    if (html[i] === '>') return { attrs, end: i + 1 }

    let nameStart = i
    // A leading "=" is part of the name (HTML's rule for a stray equals sign).
    if (html[i] === '=') i++
    while (i < n && !WHITESPACE.test(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++
    const name = html.slice(nameStart, i).toLowerCase()

    while (i < n && WHITESPACE.test(html[i])) i++
    let value = ''
    if (html[i] === '=') {
      i++
      while (i < n && WHITESPACE.test(html[i])) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1)
        const stop = close === -1 ? n : close
        value = html.slice(i + 1, stop)
        i = close === -1 ? n : close + 1
      } else {
        const valueStart = i
        while (i < n && !WHITESPACE.test(html[i]) && html[i] !== '>') i++
        value = html.slice(valueStart, i)
      }
    }
    if (name !== '' && !Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value)
  }
}

/**
 * Walk every start tag in document order, calling `onTag(name, attrs, text)`.
 * `text` is the raw text content for raw-text elements (title, textarea,
 * script, style, ...) and null for everything else. `onClose(name)`, when
 * given, is called for each closing tag.
 */
export function scanTags(html, onTag, onClose) {
  const n = html.length
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    const next = html[lt + 1]

    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4)
        i = close === -1 ? n : close + 3
      } else if (html.startsWith('<![CDATA[', lt)) {
        const close = html.indexOf(']]>', lt + 9)
        i = close === -1 ? n : close + 3
      } else {
        const close = html.indexOf('>', lt + 2)
        i = close === -1 ? n : close + 1
      }
      continue
    }
    if (next === '?') {
      const close = html.indexOf('>', lt + 2)
      i = close === -1 ? n : close + 1
      continue
    }
    if (next === '/') {
      const close = html.indexOf('>', lt + 2)
      const stop = close === -1 ? n : close
      if (onClose) onClose(html.slice(lt + 2, stop).trim().toLowerCase())
      i = close === -1 ? n : close + 1
      continue
    }
    if (next === undefined || !/[a-zA-Z]/.test(next)) {
      i = lt + 1 // a bare "<" in text
      continue
    }

    let j = lt + 1
    while (j < n && !WHITESPACE.test(html[j]) && html[j] !== '/' && html[j] !== '>') j++
    const name = html.slice(lt + 1, j).toLowerCase()
    const { attrs, end } = readAttributes(html, j)
    i = end

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, 'i')
      const rest = html.slice(i)
      const m = closeTag.exec(rest)
      const text = m ? rest.slice(0, m.index) : rest
      onTag(name, attrs, text)
      if (!m) break
      const close = html.indexOf('>', i + m.index)
      i = close === -1 ? n : close + 1
    } else {
      onTag(name, attrs, null)
    }
  }
}

/**
 * Parse `html` (fetched from `baseUrl`). Returns
 * { title, metaDescription, h1Count, canonical, robotsMeta, links }
 * where links are absolute URLs, deduped, resolved against baseUrl.
 */
export function parseHtml(html, baseUrl) {
  let titleText = null
  let description
  let canonicalHref
  let robots
  let h1Count = 0
  let svgDepth = 0
  const links = new Set()

  scanTags(html, (name, attrs, text) => {
    if (name === 'svg') {
      svgDepth += 1
      return
    }
    switch (name) {
      case 'title':
        // An <svg> carries its own <title> (a tooltip); only the document's counts.
        if (titleText === null && svgDepth === 0) titleText = decodeEntities(text ?? '')
        break
      case 'meta': {
        const metaName = (attrs.name ?? '').toLowerCase()
        // Only the first of each is read, whether or not it has content.
        if (metaName === 'description' && description === undefined) description = attrs.content ?? null
        if (metaName === 'robots' && robots === undefined) robots = attrs.content ?? null
        break
      }
      case 'link':
        if (canonicalHref === undefined && (attrs.rel ?? '').toLowerCase() === 'canonical') {
          canonicalHref = attrs.href ?? null
        }
        break
      case 'h1':
        h1Count += 1
        break
      case 'a':
        if (attrs.href) {
          const resolved = resolveUrl(attrs.href, baseUrl)
          if (resolved) links.add(resolved)
        }
        break
    }
  }, (name) => {
    if (name === 'svg' && svgDepth > 0) svgDepth -= 1
  })

  return {
    title: titleText?.trim() || null,
    metaDescription: description?.trim() || null,
    h1Count,
    canonical: canonicalHref ? resolveUrl(canonicalHref, baseUrl) : null,
    robotsMeta: robots?.trim().toLowerCase() || null,
    links: [...links]
  }
}

function resolveUrl(href, baseUrl) {
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return null
  }
  try {
    const resolved = new URL(trimmed, baseUrl)
    resolved.hash = ''
    return resolved.toString()
  } catch {
    return null
  }
}
