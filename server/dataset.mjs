/**
 * The dataset layer: one normalised page shape that both sources map onto,
 *   1. the Crawl Cove desktop app's Reports JSON export (crawlcove-export-spec), and
 *   2. a crawlcove-cli JSON result (also what crawl_site produces live),
 * plus the pure queries the MCP tools expose. No protocol code in here, so it
 * is unit-testable and reusable from plain scripts.
 *
 * A normalised page is:
 *   { url, finalUrl, statusCode, title, titleLength, metaDescription,
 *     metaLength, h1Count, canonical, robotsMeta, indexable, redirectHops,
 *     fetchError, brokenInternalLinks, depth, wordCount, contentType }
 * brokenInternalLinks is null when the source has no link graph (desktop
 * export); depth, wordCount and contentType are null for crawls.
 *
 * A dataset is { source, origin, loadedAt, pages, robotsBlocked, truncated }
 * with source one of 'desktop-export' | 'cli-result' | 'live-crawl'.
 */

export const ISSUE_TYPES = [
  'broken-page',
  'missing-title',
  'long-title',
  'duplicate-title',
  'missing-meta-description',
  'long-meta-description',
  'missing-h1',
  'multiple-h1',
  'noindex',
  'redirect-chain',
  'missing-canonical'
]

export const ISSUE_DESCRIPTIONS = {
  'broken-page': 'The page returned a 4xx/5xx status or could not be fetched',
  'missing-title': 'No <title>',
  'long-title': '<title> longer than 60 characters (may be truncated in search results)',
  'duplicate-title': 'The same <title> is used on more than one page',
  'missing-meta-description': 'No <meta name="description">',
  'long-meta-description': 'Meta description longer than 160 characters',
  'missing-h1': 'No <h1> on a 200 HTML page',
  'multiple-h1': 'More than one <h1>',
  noindex: 'The page carries a robots noindex directive',
  'redirect-chain': 'The URL went through 2 or more redirects',
  'missing-canonical': 'No <link rel="canonical"> on an indexable page'
}

const TITLE_MAX = 60
const META_MAX = 160

/* ---------- loading ---------- */

/** Identify which of the two supported JSON shapes `data` is, or null if neither. */
export function detectShape(data) {
  if (typeof data !== 'object' || data === null) return null
  if (!Array.isArray(data.pages)) return null
  if (typeof data.schemaVersion === 'string' && typeof data.auditRunId === 'number') return 'desktop-export'
  if (typeof data.seedUrl === 'string') return 'cli-result'
  return null
}

const str = (v) => (typeof v === 'string' ? v : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Keep only entries that are objects with a string url; a hand-edited file must not crash a query later. */
function validPages(pages) {
  return pages.filter((p) => typeof p === 'object' && p !== null && typeof p.url === 'string')
}

export function fromDesktopExport(data, origin, now = new Date()) {
  return {
    source: 'desktop-export',
    origin,
    loadedAt: now.toISOString(),
    truncated: false,
    robotsBlocked: [],
    pages: validPages(data.pages).map((p) => ({
      url: p.url,
      finalUrl: str(p.finalUrl),
      statusCode: num(p.statusCode),
      title: str(p.title),
      titleLength: num(p.titleLength),
      metaDescription: str(p.metaDescription),
      metaLength: num(p.metaLength),
      h1Count: num(p.h1Count),
      canonical: str(p.canonical),
      robotsMeta: str(p.robotsMeta),
      indexable: p.indexable === true,
      redirectHops: num(p.redirectHops) ?? 0,
      fetchError: str(p.fetchError),
      brokenInternalLinks: null,
      depth: num(p.depth),
      wordCount: num(p.wordCount),
      contentType: str(p.contentType)
    }))
  }
}

export function fromCliResult(data, origin, source = 'cli-result', now = new Date()) {
  return {
    source,
    origin,
    loadedAt: now.toISOString(),
    truncated: data.truncated === true,
    robotsBlocked: Array.isArray(data.robotsBlocked) ? data.robotsBlocked.filter((u) => typeof u === 'string') : [],
    pages: validPages(data.pages).map((p) => ({
      url: p.url,
      finalUrl: str(p.finalUrl),
      statusCode: num(p.statusCode),
      title: str(p.title),
      titleLength: num(p.titleLength),
      metaDescription: str(p.metaDescription),
      metaLength: num(p.metaLength),
      h1Count: num(p.h1Count),
      canonical: str(p.canonical),
      robotsMeta: str(p.robotsMeta),
      indexable: p.indexable === true,
      redirectHops: num(p.redirectHops) ?? 0,
      fetchError: str(p.fetchError),
      brokenInternalLinks: Array.isArray(p.brokenInternalLinks)
        ? p.brokenInternalLinks.filter((u) => typeof u === 'string')
        : [],
      depth: null,
      wordCount: null,
      contentType: null
    }))
  }
}

/** Parse already-read JSON text into a dataset, whichever supported shape it is. Throws with a clear message otherwise. */
export function fromJsonText(text, origin) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    // The parser's own message quotes the file's first bytes; a path given by
    // mistake should not have its contents echoed back, so it is left out.
    throw new Error(`${origin} is not valid JSON.`)
  }
  const shape = detectShape(data)
  if (shape === 'desktop-export') return fromDesktopExport(data, origin)
  if (shape === 'cli-result') return fromCliResult(data, origin)
  throw new Error(
    `${origin} is neither a Crawl Cove desktop export (schemaVersion + pages) nor a crawlcove-cli result (seedUrl + pages).`
  )
}

/* ---------- queries ---------- */

export function isBrokenPage(p) {
  return p.fetchError !== null || (p.statusCode !== null && p.statusCode >= 400)
}

export function isNoindex(p) {
  return p.robotsMeta !== null && /noindex/i.test(p.robotsMeta)
}

/** Every issue on every page as { type, url, detail }, in ISSUE_TYPES order then page order. */
export function findIssues(dataset, only) {
  const pages = dataset.pages
  const okHtml = (p) => p.statusCode === 200 && p.fetchError === null

  const titleCounts = new Map()
  for (const p of pages) {
    if (okHtml(p) && p.title) titleCounts.set(p.title, (titleCounts.get(p.title) ?? 0) + 1)
  }

  const byType = Object.fromEntries(ISSUE_TYPES.map((t) => [t, []]))
  const add = (type, url, detail) => byType[type].push({ type, url, detail })

  for (const p of pages) {
    if (isBrokenPage(p)) {
      add('broken-page', p.url, p.fetchError ?? `HTTP ${p.statusCode}`)
      continue // the remaining checks are meaningless on a page that did not load
    }
    if (!okHtml(p)) continue // redirects that were not followed, non-200s without a body
    if (!p.title || p.title.trim() === '') add('missing-title', p.url, 'no <title>')
    else {
      const length = p.titleLength ?? p.title.length
      if (length > TITLE_MAX) add('long-title', p.url, `${length} chars: "${p.title}"`)
      if ((titleCounts.get(p.title) ?? 0) > 1) {
        add('duplicate-title', p.url, `"${p.title}" is used on ${titleCounts.get(p.title)} pages`)
      }
    }
    if (!p.metaDescription || p.metaDescription.trim() === '') {
      add('missing-meta-description', p.url, 'no meta description')
    } else if ((p.metaLength ?? p.metaDescription.length) > META_MAX) {
      add('long-meta-description', p.url, `${p.metaLength ?? p.metaDescription.length} chars`)
    }
    if (p.h1Count === 0) add('missing-h1', p.url, 'no <h1>')
    else if (p.h1Count !== null && p.h1Count > 1) add('multiple-h1', p.url, `${p.h1Count} <h1> elements`)
    if (isNoindex(p)) add('noindex', p.url, `robots meta: ${p.robotsMeta}`)
    if (p.redirectHops >= 2) add('redirect-chain', p.url, `${p.redirectHops} hops → ${p.finalUrl}`)
    if (p.indexable && (p.canonical === null || p.canonical === '')) {
      add('missing-canonical', p.url, 'indexable page without a canonical')
    }
  }
  // Redirect chains are recorded on the requested URL even when the final page broke: add them for broken pages too.
  for (const p of pages) {
    if (isBrokenPage(p) && p.redirectHops >= 2) {
      add('redirect-chain', p.url, `${p.redirectHops} hops → ${p.finalUrl}`)
    }
  }

  const issues = []
  for (const t of ISSUE_TYPES) if (only === undefined || only === t) issues.push(...byType[t])
  return issues
}

export function countIssues(dataset) {
  const counts = Object.fromEntries(ISSUE_TYPES.map((t) => [t, 0]))
  for (const i of findIssues(dataset)) counts[i.type] += 1
  return counts
}

/** Find a page by URL, tolerating a missing/extra trailing slash and scheme-less input. */
export function findPage(dataset, url) {
  const norm = (u) => u.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
  const target = norm(url)
  return (
    dataset.pages.find((p) => p.url === url) ??
    dataset.pages.find((p) => norm(p.url) === target || (p.finalUrl !== null && norm(p.finalUrl) === target))
  )
}

/** { source, target, detail } pairs for broken internal links (CLI/live datasets), or null when the dataset has no link graph. */
export function listBrokenLinks(dataset) {
  if (dataset.pages.some((p) => p.brokenInternalLinks === null)) return null
  const detailOf = new Map(
    dataset.pages.map((p) => [p.url, p.fetchError ?? (p.statusCode !== null ? `HTTP ${p.statusCode}` : 'unknown')])
  )
  const out = []
  for (const p of dataset.pages) {
    for (const target of p.brokenInternalLinks ?? []) {
      out.push({ source: p.url, target, detail: detailOf.get(target) ?? 'not crawled' })
    }
  }
  return out
}

/** Filter pages by { status?, indexable?, urlContains? }. */
export function listPages(dataset, filter = {}) {
  return dataset.pages.filter(
    (p) =>
      (filter.status === undefined || p.statusCode === filter.status) &&
      (filter.indexable === undefined || p.indexable === filter.indexable) &&
      (filter.urlContains === undefined || p.url.includes(filter.urlContains))
  )
}

/** One-sentence description of a dataset, used at the top of the load and crawl answers. */
export function describe(dataset) {
  const counts = countIssues(dataset)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const where =
    dataset.source === 'desktop-export'
      ? `Crawl Cove desktop export ${dataset.origin}`
      : dataset.source === 'cli-result'
        ? `crawlcove-cli result ${dataset.origin}`
        : `live crawl of ${dataset.origin}`
  return (
    `${where}: ${dataset.pages.length} pages, ${total} issues` +
    (dataset.truncated ? ' (the crawl stopped at its page cap, so the site has more pages than this)' : '') +
    (dataset.robotsBlocked.length > 0 ? `, ${dataset.robotsBlocked.length} URLs skipped per robots.txt` : '') +
    '.'
  )
}
