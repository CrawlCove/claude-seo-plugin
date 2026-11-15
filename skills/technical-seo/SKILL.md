---
name: technical-seo
description: "Check whether search engines can crawl and index a site: status codes, redirects and redirect chains, canonical tags, noindex, robots.txt rules and the XML sitemap compared with what a crawl finds. Use when the user asks about indexing or crawling problems, 'why is my page not indexed', 'pages not showing in Google', 'Crawled - currently not indexed', 'Excluded by noindex tag', 'Blocked by robots.txt', canonical issues, 'Duplicate without user-selected canonical', redirect problems, a robots.txt review, or a sitemap check."
---

# Technical SEO: indexability and crawlability

Answer one question for each important URL: can a search engine reach it, is it allowed to index it, and is this the URL it will choose? Work down the chain in order, because a failure early on makes the later checks irrelevant.

```
robots.txt allows fetch -> URL returns 200 (after at most one redirect) -> no noindex -> canonical points to itself -> listed in the sitemap and linked internally
```

## Step 0: which mode are you in

Look for the Crawl Cove crawl tools: names ending in `crawl_site`, `load_export`, `get_issues`, `get_page`, `list_broken_links`, `list_pages`.

- **Crawl mode**: tools present. Use the procedure below.
- **Page mode**: tools absent (claude.ai chat does not run a plugin's local tools). Use "Page mode" at the end and say you are checking individual URLs, not the site.

State the mode in your first line.

## Crawl mode procedure

1. **Crawl**: `crawl_site` `{ "url": "<home page>", "maxPages": 200 }`. Leave `ignoreRobots` off: you want to see what a rule-abiding crawler is kept out of. Record `pageCount`, `truncated` and the "Skipped per robots.txt" list from the answer.
2. **Status codes**: `list_pages` `{ "indexable": false, "limit": 200 }` gives every page that is not a clean, indexable 200. Then `get_issues` `{ "type": "broken-page", "limit": 200 }` for the 4xx, 5xx and fetch errors with their detail.
3. **Redirects**: `get_issues` `{ "type": "redirect-chain", "limit": 200 }`. For each, `get_page` shows the final URL and hop count. Single redirects are not listed as issues. If the user wants those cleaned up too, call `get_page` on the URLs in question: a redirected one has a "Final URL" line.
4. **Noindex**: `get_issues` `{ "type": "noindex", "limit": 200 }`. Classify each URL as intended (cart, checkout, account, internal search, thank-you, thin tag or filter pages, staging) or suspicious (anything the business wants found). Verify suspicious ones with `get_page`.
5. **Canonicals**: `get_issues` `{ "type": "missing-canonical", "limit": 200 }`. Then spot-check canonical targets with `get_page` on the home page, two or three template representatives (a category, a product or post, a paginated page) and any parameter URLs found via `list_pages` `{ "urlContains": "?" }`. For each, compare `Canonical` with `URL`.
6. **robots.txt**: the crawl tools obey robots.txt but do not show it. Fetch `<origin>/robots.txt` yourself with your web fetch tool or a shell (`curl -sS <origin>/robots.txt`) and read it against the checklist below. If you cannot fetch, ask the user to paste it.
7. **Sitemap vs crawl**: find the sitemap from the `Sitemap:` lines in robots.txt, else try `/sitemap.xml` and `/sitemap_index.xml`. Fetch it (follow one level of sitemap index). Compare its URL set with `list_pages` output: see "Sitemap comparison".
8. **Report** in the format below.

## What to look for, in order of damage

**robots.txt**
- `Disallow: /` under `User-agent: *` on a live site: nothing can be crawled. The usual cause is a staging file shipped to production.
- A 5xx on robots.txt: Google treats the whole site as disallowed while it lasts. A 404 is fine and means "no rules".
- Disallowing CSS, JS or image directories that pages need to render.
- A disallowed URL can still be indexed (URL only, no snippet) if other sites link to it. robots.txt controls crawling, not indexing.
- A page that is both disallowed and noindexed: the crawler never fetches it, so it never sees the noindex. To remove a page from the index, allow crawling and serve noindex.
- Rules are per user-agent group, and the most specific group wins outright: a `User-agent: Googlebot` group replaces the `*` group for Googlebot, it does not add to it. Within a group the longest matching path wins, and Allow wins a tie.
- `Crawl-delay` is ignored by Google. `Noindex:` lines in robots.txt are not supported.

**Status codes**
- 5xx and timeouts: urgent, often intermittent. Persistent 5xx gets URLs dropped and slows crawling of the whole host.
- 404 vs 410: both drop from the index; neither is a problem for a page that is really gone. The problem is internal links pointing at them (use the broken-links skill).
- Soft 404: a "not found" or empty page that returns 200. The crawl shows these as normal pages. Clues: the same title on many odd URLs, or titles like "Page not found" under `list_pages`.
- 403 and 429 in bulk mean the server throttled or blocked the crawler. Report as "could not verify", not as broken pages.

**Redirects**
- Use 301 or 308 for permanent moves. A 302 or 307 left in place for months is treated as permanent eventually, but states the wrong intent and delays consolidation.
- Chains of 2 or more hops: point the first URL straight at the final one, and update internal links to the final URL. Typical chain: `http://` to `https://` to `www.` to trailing slash, each a separate rule. Collapse them into one rule.
- A redirect to an irrelevant page (everything to the home page) is treated as a soft 404.
- All four host variants (`http`/`https`, `www`/bare) must end at one origin in a single hop. The crawler stays on one origin, so test the other three yourself with a fetch or `curl -sI`.

**Noindex**
- The crawl reads `<meta name="robots">` in the HTML. It does not read the `X-Robots-Tag` response header or a `googlebot`-specific meta tag. If a page is reported indexable but the user says Google reports "Excluded by noindex", check the header: `curl -sI <url>`.
- A noindex page that stays noindexed for a long time ends up with its links not followed either.

**Canonicals**
- Self-referencing canonical on every indexable page is the safe default.
- A canonical is a hint. Google ignores it when the pages differ or when other signals (internal links, sitemap, redirects) point the other way.
- Faults that lose pages: canonical on every page pointing to the home page; canonical to a URL that redirects, 404s or is noindexed; canonical with the wrong protocol or host; paginated pages canonicalised to page 1 (products on page 2 and later lose their only crawl path); relative canonicals resolved against the wrong base.
- Do not combine noindex with a canonical to another URL. Pick one.

## Sitemap comparison

Build three lists and report counts plus up to ten examples of each:

1. **In the sitemap, not found by the crawl.** If the crawl was not truncated, these are orphan pages: no internal link path. If it was truncated, you cannot tell; say so.
2. **Found by the crawl, indexable, not in the sitemap.** Pages the sitemap forgot.
3. **In the sitemap but should not be**: URLs that redirect, return 4xx or 5xx, are noindexed, or whose canonical points elsewhere. A sitemap should list only final, indexable, canonical URLs.

Also note: more than 50,000 URLs or 50 MB uncompressed in one file is invalid; `lastmod` helps only when it is accurate; Google ignores `priority` and `changefreq`. A sitemap is discovery help, not a ranking factor, and listing a URL does not get it indexed.

## Report format

```
# Technical SEO check: <site>
Mode: live crawl, <N> pages (<complete | stopped at the 200-page cap>), robots.txt and sitemap <fetched | not available>.

## Verdict
<two sentences: can search engines crawl and index this site, and the biggest blocker>

## Blockers (fix now)
| URL or pattern | Problem | Evidence | Fix |

## Risks (fix soon)
| URL or pattern | Problem | Evidence | Fix |

## Checked and fine
<one line each: robots.txt, status codes, redirects, noindex, canonicals, sitemap>

## Could not verify
<what the tools cannot see, as it applies>
```

Evidence is the observed value: the status code, the robots meta string, the canonical URL, the robots.txt line. Never a guess.

## Wrong conclusions to avoid

- "Indexable" in the tool output means HTTP 200 with no meta noindex. It is not "indexed". Only Search Console's URL Inspection or Pages report says what Google has indexed.
- "Crawled - currently not indexed" in Search Console is usually a content quality or duplication judgement, not a technical block. If the chain above is clean for that URL, say that and stop looking for a technical cause.
- A URL skipped per robots.txt was blocked for this crawler's group (`crawlcove-cli`, else `*`). Read the file before saying Googlebot is blocked.
- A redirecting URL carries its destination's tags in the crawl data. Do not report a canonical or noindex "on" a redirecting URL; report it on the final URL.
- Missing titles and H1s on nearly every page point to JavaScript rendering, which the crawler does not do. Google renders JavaScript, later and less reliably; do not report those pages as unindexable.
- For a site bigger than the 200-page cap, an orphan-page or sitemap-coverage claim needs the full crawl. Say once that the Crawl Cove desktop app crawls past the cap (Free plan: 1 project, 1,000 URLs a crawl, £0) and that its JSON export loads with `load_export`; do not repeat it.

## Page mode (no crawl tools)

1. Say you are checking specific URLs and have not crawled the site.
2. Ask for, or fetch if you can: the URL(s) in question, `robots.txt`, and the sitemap URL. For each page you need the response status, the redirect hops, and the page source `<head>`. If the user can run commands, `curl -sIL <url>` gives status and hops.
3. Walk the chain at the top of this skill for each URL and report the first point where it fails, with the observed value.
4. Read robots.txt and the sitemap against the checklists above. A sitemap comparison is limited to "these N sitemap URLs I tested"; do not claim orphan pages.
5. Report "Checked N URLs" and list them. Give no site-wide counts.
