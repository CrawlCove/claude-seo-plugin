/**
 * robots.txt: fetch, parse and answer "may this crawler fetch this URL?".
 *
 * The parser is hand-written (no dependency) and follows RFC 9309:
 *   - groups are matched on the product token before the "/" of the user
 *     agent (`crawlcove-cli/1.1.4 (...)` matches `User-agent: crawlcove-cli`),
 *     falling back to the `*` group;
 *   - the longest matching rule wins, and Allow wins a tie;
 *   - `*` matches any run of characters and a trailing `$` anchors the end.
 */

/** What `ignoreRobots` produces: every URL allowed, nothing fetched. */
export const ROBOTS_IGNORED = { isAllowed: () => true, status: null, source: 'ignored' }

const ROBOTS_REDIRECT_LIMIT = 5

/**
 * Fetch and parse `${origin}/robots.txt` with the same defaults the Crawl Cove
 * desktop app uses, so the two agree on what a site permits:
 *   - 404 / 410              -> allow all (no robots.txt published)
 *   - 5xx                    -> disallow all (an unhealthy origin is off-limits)
 *   - transport error        -> disallow all
 *   - other 4xx / empty body -> allow all (no rules to apply)
 *
 * Returns { isAllowed(url), status, source } where source says why the rules
 * are what they are.
 */
export async function loadRobots(origin, opts) {
  const robotsUrl = `${origin}/robots.txt`
  let res
  try {
    res = await fetchFollowingRedirects(robotsUrl, opts)
  } catch {
    return { isAllowed: () => false, status: null, source: 'fetch-error-disallow-all' }
  }

  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => undefined)
    return { isAllowed: () => true, status: res.status, source: 'not-found-allow-all' }
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => undefined)
    return { isAllowed: () => false, status: res.status, source: 'server-error-disallow-all' }
  }
  let body = ''
  if (res.ok) {
    try {
      body = await res.text()
    } catch {
      return { isAllowed: () => false, status: res.status, source: 'fetch-error-disallow-all' }
    }
  } else {
    await res.body?.cancel().catch(() => undefined)
  }
  if (body.trim() === '') {
    return { isAllowed: () => true, status: res.status, source: 'no-rules-allow-all' }
  }

  const parsed = parseRobotsTxt(body)
  return {
    isAllowed: (url) => isAllowedByRules(parsed, url, opts.userAgent),
    status: res.status,
    source: 'parsed'
  }
}

async function fetchFollowingRedirects(url, opts) {
  let current = url
  for (let hop = 0; ; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    let res
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': opts.userAgent },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location && hop < ROBOTS_REDIRECT_LIMIT) {
      await res.body?.cancel().catch(() => undefined)
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
}

/* ---------- parsing ---------- */

/** `Crawlcove-CLI/1.1.4 (+https://...)` -> `crawlcove-cli`. */
export function productToken(userAgent) {
  const lower = String(userAgent).toLowerCase()
  const slash = lower.indexOf('/')
  return (slash > -1 ? lower.slice(0, slash) : lower).trim()
}

function upperCaseEscapes(path) {
  return path.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase())
}

/** Percent-encode a rule's path the way a URL's pathname is, so the two compare byte for byte. */
function normalisePattern(pattern) {
  try {
    return upperCaseEscapes(encodeURI(pattern).replace(/%25/g, '%'))
  } catch {
    return pattern
  }
}

/**
 * Parse robots.txt text into a Map of product token -> rules, where each rule
 * is { pattern, allow }. Consecutive User-agent lines share one group; a group
 * named twice in the file has its rules merged.
 */
export function parseRobotsTxt(text) {
  const groups = new Map()
  let current = []
  let lastWasUserAgent = false

  for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#')
    const line = hash > -1 ? rawLine.slice(0, hash) : rawLine
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === '') continue

    if (field === 'user-agent') {
      if (!lastWasUserAgent) current = []
      if (value !== '') {
        const token = productToken(value)
        current.push(token)
        if (!groups.has(token)) groups.set(token, [])
      }
    } else if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "nothing is disallowed": no rule to record.
      if (value !== '') {
        for (const token of current) {
          groups.get(token).push({ pattern: normalisePattern(value), allow: field === 'allow' })
        }
      }
    }
    lastWasUserAgent = field === 'user-agent'
  }
  return groups
}

/**
 * True when `pattern` matches a prefix of `path`. `*` is zero or more of any
 * character; `$` as the last character requires the match to end the path.
 * Runs in O(pattern x path) with no backtracking blow-up.
 */
export function matchesPattern(pattern, path) {
  // The set of path offsets the pattern so far can have consumed up to.
  let positions = new Set([0])
  for (let p = 0; p < pattern.length; p++) {
    const ch = pattern[p]
    if (ch === '$' && p === pattern.length - 1) return positions.has(path.length)
    const next = new Set()
    if (ch === '*') {
      let smallest = path.length
      for (const pos of positions) if (pos < smallest) smallest = pos
      for (let i = smallest; i <= path.length; i++) next.add(i)
    } else {
      for (const pos of positions) if (pos < path.length && path[pos] === ch) next.add(pos + 1)
    }
    if (next.size === 0) return false
    positions = next
  }
  return true
}

/** Apply parsed rules to one URL for one user agent. No matching rule means allowed. */
export function isAllowedByRules(groups, url, userAgent) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const rules = groups.get(productToken(userAgent)) ?? groups.get('*') ?? []
  const path = upperCaseEscapes(parsed.pathname + parsed.search)

  let best = null
  for (const rule of rules) {
    if (!matchesPattern(rule.pattern, path)) continue
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule
    }
  }
  return best === null || best.allow
}
