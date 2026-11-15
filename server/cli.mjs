#!/usr/bin/env node
/**
 * Entry point: the Crawl Cove SEO MCP server over stdio.
 *
 * stdout carries JSON-RPC and nothing else, so anything human-facing goes to
 * stderr, and console.log/info/debug are pointed there in case any code ever
 * prints. The process ends when the client closes stdin.
 */

import { format } from 'node:util'

import { serveStdio } from './protocol.mjs'
import { createServerSpec, SERVER_VERSION } from './tools.mjs'

const toStderr = (...args) => process.stderr.write(`${format(...args)}\n`)
console.log = toStderr
console.info = toStderr
console.debug = toStderr

// A client that goes away mid-write must not crash the process with EPIPE.
process.stdout.on('error', () => process.exit(0))

const { spec } = createServerSpec()
toStderr(`crawlcove ${SERVER_VERSION} ready (stdio). Tools: ${spec.tools.map((t) => t.name).join(', ')}`)

serveStdio(spec, process.stdin, process.stdout).then(() => {
  // Exit once the last reply has been flushed, not before.
  process.stdout.write('', () => process.exit(0))
})
