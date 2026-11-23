import type { EngineInterface } from 'claude-code'

import type { Entry, SymbolRef } from '../types'

export type Where = { repo?: string; ref?: string; path: string }
export type Fetched = { text: string } | { entries: Entry[] }

const cache = new Map<string, Fetched>()
const MAX_CACHE = 40

const keyOf = (w: Where) => `${w.repo ?? ''}@${w.ref ?? ''}:${w.path}`

export async function fetchSource($: EngineInterface, where: Where): Promise<Fetched> {
  const key = keyOf(where)
  const hit = cache.get(key)
  if (hit) return hit
  const got = where.repo ? await fromGitHub($, where.repo, where.path, where.ref) : await fromDisk($, where.path || '.')
  cache.set(key, got)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)

  return got
}

async function fromGitHub($: EngineInterface, repo: string, path: string, ref?: string): Promise<Fetched> {
  const endpoint = `repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
  const run = await $.process.run(['gh', 'api', endpoint], { timeoutMs: 30_000 })
  if (run.exitCode !== 0) throw new Error(`gh api failed: ${(run.stderr || run.stdout).trim()}`)
  const body = JSON.parse(run.stdout) as
    | { name: string; type: string }[]
    | { type: string; content?: string; encoding?: string }

  if (Array.isArray(body)) {
    return { entries: sortEntries(body.map(b => ({ name: b.name, isDir: b.type === 'dir' }))) }
  }
  if (body.content && body.encoding === 'base64') return { text: decode(body.content) }

  const raw = await $.process.run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', endpoint], {
    timeoutMs: 60_000,
  })
  if (raw.exitCode !== 0) throw new Error(`gh api failed: ${raw.stderr.trim()}`)

  return { text: raw.stdout }
}

async function fromDisk($: EngineInterface, path: string): Promise<Fetched> {
  try {
    return { text: await $.fs.read(path) }
  } catch (readErr) {
    try {
      const list = await $.fs.list(path)

      return { entries: sortEntries(list.map(f => ({ name: f.name, isDir: f.kind === 'dir' }))) }
    } catch {
      throw readErr
    }
  }
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries]
    .filter(e => e.name !== '.git')
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

function decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

  return new TextDecoder().decode(bytes)
}

const NOT_CALLS = new Set(
  (
    'if for while switch catch return function def class new typeof sizeof await async print elif with assert ' +
    'super self this lambda yield not and or in is len str int float list dict set tuple range isinstance type ' +
    'require import from export console log'
  ).split(' '),
)

const DEF_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected|static|async|override|readonly|\s)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
]

export function symbolsOf(text: string): SymbolRef[] {
  const out: SymbolRef[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < 300; i++) {
    const line = lines[i] ?? ''
    for (const re of DEF_PATTERNS) {
      const m = re.exec(line)
      const name = m?.[1]
      if (name && !NOT_CALLS.has(name)) {
        out.push({ name, line: i + 1, isClass: /\bclass\b/.test(line) })
        break
      }
    }
  }

  return out
}

export function callsIn(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    if (!name || NOT_CALLS.has(name) || /^\d/.test(name)) continue
    const before = text.slice(Math.max(0, (m.index ?? 0) - 9), m.index ?? 0)
    if (/(def|function|func|fn)\s+$/.test(before)) continue
    seen.add(name)
    if (seen.size >= 24) break
  }

  return [...seen]
}

export async function findDefinition(
  $: EngineInterface,
  name: string,
  from: Where,
): Promise<{ where: Where; line: number } | undefined> {
  const here = await fetchSource($, from).catch(() => undefined)
  if (here && 'text' in here) {
    const sym = symbolsOf(here.text).find(s => s.name === name)
    if (sym) return { where: from, line: sym.line }
  }

  return from.repo ? findOnGitHub($, name, from) : findOnDisk($, name, from)
}

async function findOnDisk($: EngineInterface, name: string, from: Where) {
  const safe = name.replace(/[^\w$]/g, '')
  const pattern =
    `(def|function|func|fn|class)[[:space:]]+${safe}([^[:alnum:]_]|$)` +
    `|func[[:space:]]+\\([^)]*\\)[[:space:]]*${safe}\\(` +
    `|(const|let|var)[[:space:]]+${safe}[[:space:]]*=`
  const run = await $.process.run(['git', 'grep', '-n', '-I', '-E', pattern], { timeoutMs: 20_000 }).catch(() => undefined)
  const first = run?.exitCode === 0 ? run.stdout.split('\n').find(Boolean) : undefined
  if (!first) return undefined
  const [path, line] = first.split(':')
  if (!path || !line) return undefined

  return { where: { path }, line: Number(line) }
}

async function findOnGitHub($: EngineInterface, name: string, from: Where) {
  const run = await $.process
    .run(['gh', 'search', 'code', name, '--repo', from.repo ?? '', '--limit', '15', '--json', 'path'], {
      timeoutMs: 30_000,
    })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) return undefined
  const paths = (JSON.parse(run.stdout || '[]') as { path: string }[]).map(p => p.path)
  for (const path of paths.slice(0, 8)) {
    const where = { repo: from.repo, ref: from.ref, path }
    const got = await fetchSource($, where).catch(() => undefined)
    if (!got || !('text' in got)) continue
    const sym = symbolsOf(got.text).find(s => s.name === name)
    if (sym) return { where, line: sym.line }
  }

  return undefined
}
