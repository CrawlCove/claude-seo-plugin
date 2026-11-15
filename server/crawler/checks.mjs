/** A redirect chain is 2+ hops. A single redirect (old URL to its new home) is normal and not flagged. */
const REDIRECT_CHAIN_MIN_HOPS = 2

/** Count each category's issues across a crawl's pages: { brokenLinks, missingTitles, noindex, redirectChains }. */
export function summarizeChecks(result) {
  let brokenLinks = 0
  let missingTitles = 0
  let noindex = 0
  let redirectChains = 0

  for (const page of result.pages) {
    brokenLinks += page.brokenInternalLinks.length
    if (page.fetchError !== null || (page.statusCode !== null && page.statusCode >= 400)) {
      brokenLinks += 1
    }
    if (!page.title || page.title.trim() === '') missingTitles += 1
    if (page.robotsMeta !== null && /noindex/.test(page.robotsMeta)) noindex += 1
    if (page.redirectHops >= REDIRECT_CHAIN_MIN_HOPS) redirectChains += 1
  }

  return { brokenLinks, missingTitles, noindex, redirectChains }
}
