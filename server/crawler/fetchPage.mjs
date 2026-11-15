const MAX_REDIRECT_HOPS = 20

/**
 * Fetch a URL, following redirects manually so the hop count is observable
 * (the fetch spec's automatic redirect following discards it). Stops and
 * reports an error after MAX_REDIRECT_HOPS rather than looping forever on a
 * redirect cycle.
 *
 * Returns { finalUrl, statusCode, redirectHops, fetchError, contentType, body }.
 * `body` is the HTML text, or null for a non-HTML response or a failed fetch.
 */
export async function fetchPage(url, opts) {
  let currentUrl = url
  let hops = 0

  for (;;) {
    let res
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
      try {
        res = await fetch(currentUrl, {
          redirect: 'manual',
          headers: { 'user-agent': opts.userAgent },
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      const message = err instanceof Error ? err.name : String(err)
      return {
        finalUrl: currentUrl,
        statusCode: null,
        redirectHops: hops,
        fetchError: message === 'AbortError' ? 'TIMEOUT' : message,
        contentType: null,
        body: null
      }
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      hops += 1
      // Release the connection: a redirect's body is never read.
      await res.body?.cancel().catch(() => undefined)
      if (hops > MAX_REDIRECT_HOPS) {
        return {
          finalUrl: currentUrl,
          statusCode: res.status,
          redirectHops: hops,
          fetchError: 'TOO_MANY_REDIRECTS',
          contentType: null,
          body: null
        }
      }
      try {
        currentUrl = new URL(res.headers.get('location'), currentUrl).toString()
      } catch {
        return {
          finalUrl: currentUrl,
          statusCode: res.status,
          redirectHops: hops,
          fetchError: 'INVALID_REDIRECT',
          contentType: null,
          body: null
        }
      }
      continue
    }

    const contentType = res.headers.get('content-type')
    const isHtml = contentType === null || /text\/html|application\/xhtml\+xml/i.test(contentType)
    let body = null
    if (isHtml) {
      try {
        body = await res.text()
      } catch (err) {
        return {
          finalUrl: currentUrl,
          statusCode: res.status,
          redirectHops: hops,
          fetchError: err instanceof Error ? err.name : String(err),
          contentType,
          body: null
        }
      }
    } else {
      await res.body?.cancel().catch(() => undefined)
    }
    return {
      finalUrl: currentUrl,
      statusCode: res.status,
      redirectHops: hops,
      fetchError: null,
      contentType,
      body
    }
  }
}
