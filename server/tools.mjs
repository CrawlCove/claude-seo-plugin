/**
 * The six tools, their JSON schemas, and the hand-written argument validation
 * that stands in for a schema library. Each handler returns an MCP tool result:
 * { content: [{ type: 'text', text }], structuredContent?, isError? }.
 *
 * Every answer is capped at about MAX_RESPONSE_CHARS. A list that does not fit
 * is cut to whole items and ends with a line saying how many were left out and
 * which argument narrows it.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { crawlSite, DEFAULT_CRAWL_OPTIONS, SeedBlockedByRobotsError } from './crawler/crawl.mjs'
import {
  countIssues,
  describe,
  findIssues,
  findPage,
  fromCliResult,
  fromJsonText,
  ISSUE_DESCRIPTIONS,
  ISSUE_TYPES,
  listBrokenLinks,
  listPages
} from './dataset.mjs'

export const SERVER_NAME = 'crawlcove'
export const SERVER_VERSION = '1.0.0'

/** Hard ceiling on a live crawl. Bigger sites are what the desktop app is for. */
export const MAX_LIVE_PAGES = 200
export const DEFAULT_LIVE_PAGES = 50
export const DEFAULT_LIST_LIMIT = 50
/** Longest answer a tool returns, text and structured content together. */
export const MAX_RESPONSE_CHARS = 25_000
/** Largest export file load_export will read. */
const MAX_EXPORT_BYTES = 256 * 1024 * 1024
/** Longest single title or URL echoed in a list line. */
const MAX_FIELD_CHARS = 300

const DESKTOP_URL = 'https://crawlcove.com/?utm_source=claude-plugin&utm_medium=claude-seo-plugin'
const NO_DATASET =
  'No crawl data loaded yet. Call crawl_site with a URL for a live crawl (up to ' +
  `${MAX_LIVE_PAGES} pages), or load_export with the path to a Crawl Cove desktop export or crawlcove-cli JSON file.`

export const SERVER_INSTRUCTIONS =
  'SEO crawl data for one site at a time. Start with crawl_site (live, same-origin, robots.txt respected, at most ' +
  `${MAX_LIVE_PAGES} pages) or load_export (a Crawl Cove desktop export or crawlcove-cli JSON file, no page cap). ` +
  'That becomes the active dataset; get_issues, get_page, list_broken_links and list_pages then answer from it. ' +
  'A new crawl_site or load_export replaces the active dataset. Numbers describe the pages in the dataset, ' +
  'which is not the whole site when the crawl reports it was truncated.'

/* ---------- tool definitions ---------- */

const TOOLS = [
  {
    name: 'crawl_site',
    title: 'Crawl a site',
    description:
      'Crawl a website live and make the result the active dataset for the other tools. Follows same-origin links ' +
      'breadth-first from the start URL, respects robots.txt, and records for each page: status code, redirect hops, ' +
      'title, meta description, H1 count, canonical, robots meta and broken internal links. ' +
      `Stops at maxPages (default ${DEFAULT_LIVE_PAGES}, hard cap ${MAX_LIVE_PAGES}); the answer says when the cap cut the crawl short. ` +
      'It reads the HTML the server sends and does not run JavaScript. Returns the page count and issue counts by type. ' +
      'For a site with more pages, crawl it in the Crawl Cove desktop app and load its JSON export with load_export.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Start URL with http:// or https://, for example https://example.com/'
        },
        maxPages: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIVE_PAGES,
          description: `Page cap (default ${DEFAULT_LIVE_PAGES}, max ${MAX_LIVE_PAGES})`
        },
        ignoreRobots: {
          type: 'boolean',
          description: 'Also crawl URLs that robots.txt disallows. Only for sites you own or are authorised to crawl. Default false.'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    annotations: { title: 'Crawl a site', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'load_export',
    title: 'Load a crawl export',
    description:
      'Load a crawl from a JSON file on this computer and make it the active dataset: either a Crawl Cove desktop app ' +
      'export (Reports, Export, JSON) or a crawlcove-cli JSON result. Desktop exports have no page cap and carry more ' +
      'per page (depth, word count, content type); they have no link graph, so list_broken_links lists the broken pages ' +
      'without their sources. Reads the file and nothing else.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Path to the .json file. Absolute is best; a leading ~ is expanded.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { title: 'Load a crawl export', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'get_issues',
    title: 'List SEO issues',
    description:
      'List the SEO issues found in the active dataset as type, URL and detail, with a count per type. Pass type to see ' +
      'one type only. Types: ' +
      ISSUE_TYPES.map((t) => `${t} (${ISSUE_DESCRIPTIONS[t]})`).join('; ') +
      '. Call crawl_site or load_export first.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ISSUE_TYPES, description: 'Restrict to one issue type' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: `Max issues to return (default ${DEFAULT_LIST_LIMIT})` }
      },
      additionalProperties: false
    },
    annotations: { title: 'List SEO issues', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'get_page',
    title: 'Get one page',
    description:
      'Return everything the active dataset recorded about one URL: status, final URL and redirect hops, indexability, ' +
      'title and meta description with lengths, H1 count, canonical, robots meta, broken links out, and the issue types ' +
      'on the page. Use it before drafting a new title or description for a page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, description: 'The page URL as crawled. A missing scheme or trailing slash is tolerated.' }
      },
      required: ['url'],
      additionalProperties: false
    },
    annotations: { title: 'Get one page', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'list_broken_links',
    title: 'List broken internal links',
    description:
      'Broken internal links as source page → broken target pairs with the target\'s failure (HTTP status or fetch error), ' +
      'so you know which page to edit. Needs a live crawl or a crawlcove-cli dataset. A desktop export has no link graph: ' +
      'for one, this lists the broken pages only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: `Max entries (default ${DEFAULT_LIST_LIMIT})` }
      },
      additionalProperties: false
    },
    annotations: { title: 'List broken internal links', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'list_pages',
    title: 'List pages',
    description:
      'List the pages in the active dataset with status code, indexability and title. Filter by exact HTTP status, by ' +
      'indexable true/false, or by a substring of the URL (for example "/blog/"). Combine filters to narrow a long list.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'integer', minimum: 100, maximum: 599, description: 'Only pages with this HTTP status, for example 404' },
        indexable: { type: 'boolean', description: 'Only indexable (true) or non-indexable (false) pages' },
        urlContains: { type: 'string', description: 'Only URLs containing this substring' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: `Max pages (default ${DEFAULT_LIST_LIMIT})` }
      },
      additionalProperties: false
    },
    annotations: { title: 'List pages', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

/* ---------- argument validation ---------- */

class ArgError extends Error {}

/** Check `args` against one tool's inputSchema. Covers exactly the keywords the schemas above use. */
export function validateArgs(schema, args) {
  const known = Object.keys(schema.properties)
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) {
      throw new ArgError(
        `Unknown argument "${key}". This tool takes: ${known.length > 0 ? known.join(', ') : 'no arguments'}.`
      )
    }
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) throw new ArgError(`${key} is required.`)
  }
  const clean = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (prop.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new ArgError(`${key} must be a whole number.`)
      if (prop.minimum !== undefined && v < prop.minimum) throw new ArgError(`${key} must be at least ${prop.minimum}.`)
      if (prop.maximum !== undefined && v > prop.maximum) throw new ArgError(`${key} must be at most ${prop.maximum}.`)
    } else if (prop.type === 'boolean') {
      if (typeof v !== 'boolean') throw new ArgError(`${key} must be true or false.`)
    } else if (prop.type === 'string') {
      if (typeof v !== 'string') throw new ArgError(`${key} must be a string.`)
      if (prop.minLength !== undefined && v.length < prop.minLength) throw new ArgError(`${key} must not be empty.`)
      if (prop.enum !== undefined && !prop.enum.includes(v)) {
        throw new ArgError(`${key} must be one of: ${prop.enum.join(', ')}.`)
      }
      if (prop.format === 'uri') {
        let parsed = null
        try {
          parsed = new URL(v)
        } catch {
          // handled below
        }
        if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          throw new ArgError(`${key} must be a full http:// or https:// URL, for example https://example.com/`)
        }
      }
    }
    clean[key] = v
  }
  return clean
}

/* ---------- results ---------- */

function text(t, structured) {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) }
}

function fail(t) {
  return { content: [{ type: 'text', text: t }], isError: true }
}

function clip(s, max = MAX_FIELD_CHARS) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatCounts(counts) {
  return (
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `- ${t}: ${n}`)
      .join('\n') || '- none'
  )
}

function resultSize(result) {
  return result.content[0].text.length + (result.structuredContent ? JSON.stringify(result.structuredContent).length : 0)
}

/**
 * Build a list answer that fits the response cap. `build(shown, left)` renders
 * the first `shown.length` items and is told how many are left out; the
 * largest count that fits MAX_RESPONSE_CHARS (and `limit`) is used.
 */
function fitList(items, limit, build) {
  const most = Math.min(items.length, limit)
  const render = (k) => build(items.slice(0, k), items.length - k, k < most)
  let result = render(most)
  if (resultSize(result) <= MAX_RESPONSE_CHARS) return result
  let lo = 0
  let hi = most - 1
  result = render(0)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = render(mid)
    if (resultSize(candidate) <= MAX_RESPONSE_CHARS) {
      lo = mid
      result = candidate
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** The closing line of a cut list: how many are missing, why, and what narrows it. */
function moreLine(left, cutBySize, narrowWith) {
  if (left <= 0) return ''
  return cutBySize
    ? `\n…and ${left} more, left out to keep this answer under ${MAX_RESPONSE_CHARS} characters. Narrow with ${narrowWith}.`
    : `\n…and ${left} more. Raise limit, or narrow with ${narrowWith}.`
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function defaultReadFile(path) {
  const full = resolve(expandHome(path))
  const stat = statSync(full)
  if (!stat.isFile()) throw new Error('it is not a file')
  if (stat.size > MAX_EXPORT_BYTES) throw new Error(`it is larger than ${MAX_EXPORT_BYTES / (1024 * 1024)} MB`)
  return readFileSync(full, 'utf8')
}

/* ---------- the server spec ---------- */

/**
 * Build the tool set. Options are for tests: `crawl` replaces the live
 * crawler, `readFile` replaces file reading, `now` fixes the clock.
 * Returns { tools, callTool, state } where state.dataset is the active dataset.
 */
export function createTools(opts = {}) {
  const crawl = opts.crawl ?? crawlSite
  const readFile = opts.readFile ?? defaultReadFile
  const now = opts.now ?? (() => new Date())
  const state = { dataset: null }

  const handlers = {
    async crawl_site({ url, maxPages, ignoreRobots }) {
      const cap = Math.min(maxPages ?? DEFAULT_LIVE_PAGES, MAX_LIVE_PAGES)
      let dataset
      try {
        const result = await crawl(url, {
          ...DEFAULT_CRAWL_OPTIONS,
          maxPages: cap,
          ignoreRobots: ignoreRobots ?? false
        })
        dataset = fromCliResult(result, url, 'live-crawl', now())
      } catch (err) {
        if (err instanceof SeedBlockedByRobotsError) {
          return fail(
            `robots.txt disallows ${url} for this crawler (or robots.txt could not be fetched, which is treated as "keep out"), ` +
              'so nothing was crawled. If you own the site, call again with ignoreRobots: true.'
          )
        }
        return fail(`Crawl failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      state.dataset = dataset
      const counts = countIssues(dataset)
      const lines = [describe(dataset), '', 'Issue counts:', formatCounts(counts)]
      if (dataset.robotsBlocked.length > 0) {
        const sample = dataset.robotsBlocked.slice(0, 10)
        lines.push('', `Skipped per robots.txt (${dataset.robotsBlocked.length}):`, ...sample.map((u) => `- ${clip(u)}`))
        if (dataset.robotsBlocked.length > sample.length) lines.push(`…and ${dataset.robotsBlocked.length - sample.length} more.`)
      }
      if (dataset.truncated) {
        lines.push(
          '',
          cap < MAX_LIVE_PAGES
            ? `The crawl stopped at maxPages (${cap}) with more URLs still queued. Raise maxPages (max ${MAX_LIVE_PAGES}) to see more of the site.`
            : `The crawl stopped at this tool's ${MAX_LIVE_PAGES}-page cap with more URLs still queued, so these numbers cover part of the site. ` +
                `For the whole site, crawl it in the Crawl Cove desktop app (${DESKTOP_URL}) and load its JSON export with load_export.`
        )
      }
      lines.push('', 'Next: get_issues for the list, get_page for one URL, list_broken_links for link sources, list_pages to browse.')
      return text(lines.join('\n'), {
        pageCount: dataset.pages.length,
        truncated: dataset.truncated,
        robotsBlocked: dataset.robotsBlocked.length,
        issueCounts: counts
      })
    },

    async load_export({ path }) {
      let raw
      try {
        raw = readFile(path)
      } catch (err) {
        return fail(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
      let dataset
      try {
        dataset = fromJsonText(raw, path)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
      state.dataset = dataset
      const counts = countIssues(dataset)
      return text(describe(dataset) + '\n\nIssue counts:\n' + formatCounts(counts), {
        source: dataset.source,
        pageCount: dataset.pages.length,
        issueCounts: counts
      })
    },

    async get_issues({ type, limit }) {
      if (!state.dataset) return fail(NO_DATASET)
      const dataset = state.dataset
      const all = findIssues(dataset, type)
      const counts = countIssues(dataset)
      const head = type
        ? `${all.length} ${type} issue(s)`
        : `${all.length} issue(s) across ${Object.values(counts).filter((n) => n > 0).length} types`
      return fitList(all, limit ?? DEFAULT_LIST_LIMIT, (shown, left, cutBySize) => {
        const body = shown.map((i) => `- [${i.type}] ${clip(i.url)}: ${clip(i.detail)}`).join('\n')
        return text(
          `${head} in ${dataset.pages.length} pages.\n${type ? '' : formatCounts(counts) + '\n'}\n${body || '(none)'}` +
            moreLine(left, cutBySize, type ? 'a smaller limit, or use list_pages with urlContains to work through one section' : 'type'),
          { total: all.length, counts, issues: shown }
        )
      })
    },

    async get_page({ url }) {
      if (!state.dataset) return fail(NO_DATASET)
      const dataset = state.dataset
      const found = findPage(dataset, url)
      if (!found) {
        return fail(`${url} is not in the active dataset (${dataset.pages.length} pages). Use list_pages with urlContains to search.`)
      }
      const issues = findIssues(dataset).filter((i) => i.url === found.url)
      const MAX_LINKS = 50
      const broken = found.brokenInternalLinks
      const page =
        broken && broken.length > MAX_LINKS
          ? { ...found, brokenInternalLinks: broken.slice(0, MAX_LINKS), brokenInternalLinksTotal: broken.length }
          : found
      const lines = [
        `URL: ${page.url}`,
        page.finalUrl && page.finalUrl !== page.url ? `Final URL: ${page.finalUrl} (${page.redirectHops} redirect hop(s))` : null,
        `Status: ${page.statusCode ?? 'none'}${page.fetchError ? ` (fetch error: ${page.fetchError})` : ''}`,
        `Indexable: ${page.indexable ? 'yes' : 'no'}${page.robotsMeta ? ` (robots meta: ${page.robotsMeta})` : ''}`,
        `Title: ${page.title ?? '(none)'}${page.titleLength !== null ? ` [${page.titleLength} chars]` : ''}`,
        `Meta description: ${page.metaDescription ?? '(none)'}${page.metaLength !== null ? ` [${page.metaLength} chars]` : ''}`,
        `H1 count: ${page.h1Count ?? 'n/a'}`,
        `Canonical: ${page.canonical ?? '(none)'}`,
        page.depth !== null ? `Depth: ${page.depth}` : null,
        page.wordCount !== null ? `Word count: ${page.wordCount}` : null,
        broken && broken.length > 0
          ? `Broken links out (${broken.length}): ${page.brokenInternalLinks.join(', ')}${broken.length > MAX_LINKS ? `, …and ${broken.length - MAX_LINKS} more (see list_broken_links)` : ''}`
          : null,
        issues.length > 0 ? `Issues: ${issues.map((i) => i.type).join(', ')}` : 'Issues: none'
      ].filter((l) => l !== null)
      return text(lines.join('\n'), { page, issues })
    },

    async list_broken_links({ limit }) {
      if (!state.dataset) return fail(NO_DATASET)
      const dataset = state.dataset
      const cap = limit ?? DEFAULT_LIST_LIMIT
      const links = listBrokenLinks(dataset)
      if (links === null) {
        const broken = findIssues(dataset, 'broken-page')
        return fitList(broken, cap, (shown, left, cutBySize) =>
          text(
            `${broken.length} broken page(s). This desktop export has no link graph, so the pages that link to them are not listed here. ` +
              `Open the run in the Crawl Cove desktop app for inlinks, or use crawl_site for a live crawl with sources.\n` +
              shown.map((i) => `- ${clip(i.url)}: ${i.detail}`).join('\n') +
              moreLine(left, cutBySize, 'a smaller limit, or list_pages with status and urlContains'),
            { brokenPages: shown, total: broken.length, hasLinkGraph: false }
          )
        )
      }
      return fitList(links, cap, (shown, left, cutBySize) =>
        text(
          `${links.length} broken internal link(s).\n` +
            (shown.map((l) => `- ${clip(l.source)} → ${clip(l.target)} (${l.detail})`).join('\n') || '(none)') +
            moreLine(left, cutBySize, 'a smaller limit, or get_page on one source page for its broken links'),
          { brokenLinks: shown, total: links.length, hasLinkGraph: true }
        )
      )
    },

    async list_pages({ status, indexable, urlContains, limit }) {
      if (!state.dataset) return fail(NO_DATASET)
      const dataset = state.dataset
      const pages = listPages(dataset, { status, indexable, urlContains })
      return fitList(pages, limit ?? DEFAULT_LIST_LIMIT, (shown, left, cutBySize) =>
        text(
          `${pages.length} of ${dataset.pages.length} pages match.\n` +
            shown
              .map((p) => `- ${p.statusCode ?? 'ERR'} ${clip(p.url)}${p.indexable ? '' : ' [not indexable]'}${p.title ? ` | ${clip(p.title)}` : ''}`)
              .join('\n') +
            moreLine(left, cutBySize, 'urlContains, status or indexable'),
          {
            total: pages.length,
            pages: shown.map((p) => ({ url: p.url, statusCode: p.statusCode, title: p.title, indexable: p.indexable }))
          }
        )
      )
    }
  }

  /** Run one tool. Returns undefined for a tool that does not exist. */
  async function callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return undefined
    let clean
    try {
      clean = validateArgs(tool.inputSchema, args)
    } catch (err) {
      if (err instanceof ArgError) return fail(`Invalid arguments for ${name}: ${err.message}`)
      throw err
    }
    return handlers[name](clean)
  }

  return { tools: TOOLS, callTool, state }
}

/** The spec protocol.mjs serves: name, version, instructions, tools, callTool. */
export function createServerSpec(opts = {}) {
  const { tools, callTool, state } = createTools(opts)
  return {
    spec: { name: SERVER_NAME, version: SERVER_VERSION, instructions: SERVER_INSTRUCTIONS, tools, callTool },
    state
  }
}
