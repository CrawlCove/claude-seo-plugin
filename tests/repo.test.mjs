import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SERVER_VERSION } from '../server/tools.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_FILE_BYTES = 256 * 1024
const EM_DASH = String.fromCodePoint(0x2014)
// Built from parts so this file does not match its own check.
const ATTRIBUTION = new RegExp(['co-authored', 'by'].join('-') + '|' + ['generated', '(with|by)'].join(' '), 'i')

/** Every file in the repo except .git and node_modules, as paths relative to the root. */
function walk(dir = ROOT) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    const stat = lstatSync(full)
    assert.equal(stat.isSymbolicLink(), false, `${relative(ROOT, full)} is a symlink`)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(relative(ROOT, full))
  }
  return out
}

const files = walk()
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const json = (rel) => JSON.parse(read(rel))

/** The `key: "value"` pairs of a SKILL.md frontmatter block. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(m, 'SKILL.md must start with a frontmatter block')
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line)
    assert.ok(kv, `frontmatter line is not key: value: ${line}`)
    out[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2]
  }
  return { fields: out, body: text.slice(m[0].length) }
}

describe('the plugin bundle', () => {
  it('has the files the plugin needs and none it must not ship', () => {
    for (const needed of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json', 'server/cli.mjs', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
      assert.ok(files.includes(needed), `${needed} is missing`)
    }
    for (const f of files) {
      const name = f.split('/').pop()
      assert.ok(!['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.DS_Store', '.env'].includes(name), `${f} must not be in the bundle`)
      assert.ok(lstatSync(join(ROOT, f)).size < MAX_FILE_BYTES, `${f} is 256 KiB or more`)
      assert.ok(!readFileSync(join(ROOT, f)).includes(0), `${f} looks binary`)
    }
  })

  it('contains no em dashes and no AI attribution', () => {
    for (const f of files) {
      const text = read(f)
      assert.ok(!text.includes(EM_DASH), `${f} contains an em dash`)
      assert.doesNotMatch(text, ATTRIBUTION, f)
    }
  })

  it('server code imports only node: builtins and its own files', () => {
    for (const f of files.filter((p) => p.startsWith('server/'))) {
      assert.ok(f.endsWith('.mjs'), `${f} is not an .mjs file`)
      for (const [, spec] of read(f).matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${f} imports ${spec}`)
      }
      assert.doesNotMatch(read(f), /\brequire\(|\bimport\(/, `${f} uses a dynamic import`)
    }
  })

  it('plugin.json, marketplace.json and .mcp.json agree with each other and the server', () => {
    const plugin = json('.claude-plugin/plugin.json')
    assert.equal(plugin.name, 'crawlcove-seo')
    assert.equal(plugin.displayName, 'Crawl Cove SEO')
    assert.equal(plugin.version, SERVER_VERSION)
    assert.equal(plugin.author.name, 'Crawl Cove')
    assert.equal(plugin.license, 'MIT')
    assert.match(plugin.repository, /github\.com\/CrawlCove\/claude-seo-plugin$/)
    assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.length > 0)

    const market = json('.claude-plugin/marketplace.json')
    assert.equal(market.name, 'crawlcove')
    assert.equal(market.plugins.length, 1)
    assert.equal(market.plugins[0].name, plugin.name)
    assert.equal(market.plugins[0].source, './')

    assert.deepEqual(json('.mcp.json'), {
      mcpServers: { crawlcove: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/cli.mjs'] } }
    })
    assert.match(read('CHANGELOG.md'), new RegExp(`^## ${plugin.version.replaceAll('.', '\\.')} `, 'm'))
  })

  it('every skill has a matching name, a one-line description that says when to use it, and both modes', () => {
    const skills = files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f))
    assert.ok(skills.length >= 6 && skills.length <= 8, `${skills.length} skills`)
    for (const f of skills) {
      const { fields, body } = frontmatter(read(f))
      assert.equal(fields.name, f.split('/')[1], f)
      assert.equal(typeof fields.description, 'string', f)
      assert.ok(fields.description.length >= 150 && fields.description.length <= 1024, `${f} description is ${fields.description.length} chars`)
      assert.match(fields.description, /Use when/, f)
      const lines = body.split('\n').length
      assert.ok(lines >= 80 && lines <= 200, `${f} body is ${lines} lines`)
      assert.match(body, /crawl_site/, `${f} never names the crawl tool`)
      assert.match(body, /Page mode/, `${f} has no page mode`)
      assert.match(body, /Wrong conclusions to avoid/, f)
    }
    const readme = read('README.md')
    for (const f of skills) assert.ok(readme.includes('`' + f.split('/')[1] + '`'), `README does not list ${f}`)
  })
})
