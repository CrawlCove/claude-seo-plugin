/**
 * A minimal Model Context Protocol server over stdio.
 *
 * Hand-written on purpose: over stdio MCP is newline-delimited JSON-RPC 2.0
 * and five methods, so this plugin ships with no dependencies to install.
 *
 * What it speaks: initialize, notifications/*, ping, tools/list, tools/call.
 * Anything else is -32601. A tool that fails is NOT a JSON-RPC error: per MCP
 * it is a normal result with isError: true, so the model can read the reason.
 *
 * Pure: no console, no process. stdout belongs to the protocol, so this
 * module writes only to the stream it is handed.
 */

import { StringDecoder } from 'node:string_decoder'

/** Newest first. initialize answers with the client's version if listed here, else the first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** JSON-RPC 2.0 error codes used here. */
export const RpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validId(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

/**
 * Handle one raw line. Returns the response to send, or null when nothing is
 * owed (a notification, or a response the client sent us).
 *
 * `spec` is { name, version, instructions?, tools, callTool(name, args) }.
 * callTool returns a tool result, or undefined for a tool it does not know.
 */
export async function handleMessage(spec, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return fail(null, RpcError.ParseError, 'Parse error: the line is not valid JSON.')
  }
  if (!isRecord(msg)) {
    return fail(null, RpcError.InvalidRequest, 'Invalid request: send one JSON-RPC object per line.')
  }
  const id = validId(msg.id) ? msg.id : null
  if (msg.jsonrpc !== '2.0') {
    return fail(id, RpcError.InvalidRequest, 'Invalid request: jsonrpc must be "2.0".')
  }
  if (typeof msg.method !== 'string') {
    // A response to a request we never send. Nothing to answer.
    if ('result' in msg || 'error' in msg) return null
    return fail(id, RpcError.InvalidRequest, 'Invalid request: method must be a string.')
  }
  if (!('id' in msg)) return null // a notification
  if (!validId(msg.id)) {
    return fail(null, RpcError.InvalidRequest, 'Invalid request: id must be a string or a number.')
  }

  const params = msg.params
  switch (msg.method) {
    case 'initialize': {
      const asked = isRecord(params) ? params.protocolVersion : undefined
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0]
      return ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: spec.name, version: spec.version },
        ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {})
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: spec.tools })
    case 'tools/call': {
      if (!isRecord(params) || typeof params.name !== 'string') {
        return fail(id, RpcError.InvalidParams, 'Invalid params: tools/call needs a tool "name".')
      }
      const args = params.arguments
      if (args !== undefined && args !== null && !isRecord(args)) {
        return fail(id, RpcError.InvalidParams, 'Invalid params: "arguments" must be an object.')
      }
      try {
        const result = await spec.callTool(params.name, args ?? {})
        if (result === undefined) return fail(id, RpcError.InvalidParams, `Unknown tool: ${params.name}`)
        return ok(id, result)
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        return ok(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      return fail(id, RpcError.MethodNotFound, `Method not found: ${msg.method}`)
  }
}

/**
 * Split a byte stream into lines. Handles a message split across chunks, many
 * messages in one chunk, CRLF, and a UTF-8 character split across two Buffers.
 */
export function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  function emit(line) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed.trim() !== '') onLine(trimmed)
  }
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        emit(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    },
    end() {
      buffer += decoder.end()
      if (buffer !== '') emit(buffer)
      buffer = ''
    }
  }
}

/**
 * Serve `spec` over a pair of streams. Responses go out in request order, one
 * JSON object per line. Resolves when the input ends and every reply is written.
 */
export function serveStdio(spec, input, output) {
  let queue = Promise.resolve()
  const reader = createLineReader((line) => {
    queue = queue.then(async () => {
      let res
      try {
        res = await handleMessage(spec, line)
      } catch (err) {
        res = fail(null, RpcError.InternalError, `Internal error: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (res !== null) output.write(JSON.stringify(res) + '\n')
    })
  })
  return new Promise((resolve) => {
    input.on('data', (chunk) => reader.push(chunk))
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      reader.end()
      void queue.then(() => resolve())
    }
    input.once('end', finish)
    input.once('close', finish)
  })
}
