import { createServer } from 'node:http'

/**
 * A tiny in-process HTTP server for crawler tests: no real network calls.
 * `routes` maps a path to { status?, headers?, body?, hang? }. An unknown path
 * is a 404; a route with hang: true never answers.
 */
export class FixtureServer {
  constructor(routes) {
    this.routes = new Map(Object.entries(routes))
    this.requests = []
    this.server = createServer((req, res) => {
      this.requests.push({ url: req.url, userAgent: req.headers['user-agent'] })
      const route = this.routes.get(req.url ?? '/')
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/html' })
        res.end('<html><body>not found</body></html>')
        return
      }
      if (route.hang) return
      res.writeHead(route.status ?? 200, { 'content-type': 'text/html', ...route.headers })
      res.end(route.body ?? '')
    })
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${this.server.address().port}`
  }

  async close() {
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(() => resolve()))
  }
}
