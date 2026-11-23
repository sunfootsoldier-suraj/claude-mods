import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Excerpt, Stop } from '../types'
import { callsIn, fetchSource, findDefinition, symbolsOf } from './source'
import type { Where } from './source'
import { codeSvg } from './svg'

const PANE = 'github-browse'
const TITLE = 'GitHub'
const TOOL = 'mcp__github-browse__github_show'
const CONTEXT = 10
const PREVIEW = 80
const MAX_FOCUS = 400
const MAX_STOPS = 60

const stops = atom({ plugin: 'github-browse', key: 'stops' } as const, [], { shape: 'stops-2' })
const cursor = atom({ plugin: 'github-browse', key: 'cursor' } as const, -1, { shape: 'cursor-1' })
const busy = atom({ plugin: 'github-browse', key: 'busy' } as const, '', { shape: 'busy-1' })
const outline = atom({ plugin: 'github-browse', key: 'outline' } as const, false, { shape: 'outline-1' })

let cwd = ''

type ShowInput = {
  repo?: string
  path?: string
  ref?: string
  start_line?: number
  end_line?: number
  title?: string
  note?: string
  new_trace?: boolean
}

type OpenOpts = {
  start?: number
  end?: number
  title?: string
  note?: string
  isUser: boolean
  context?: number
}

const DESCRIPTION = [
  'Drive the GitHub-style code browser pane beside the chat so the user sees exactly the code you are talking about.',
  'Use it whenever you analyze, debug, explain or review code. For a debugging walk-through, call it once per step of the trace',
  '(entry point → each call → where it goes wrong), in order, right before the paragraph about that step; set new_trace on the first step',
  'of a new walk-through. Each call becomes a numbered, clickable step in the pane, and the user can click function calls to jump to their definitions.',
  'repo is "owner/name" on GitHub (read with the gh CLI); leave it out for files on this machine (path relative to the working directory, or absolute).',
  'start_line/end_line (1-based, inclusive) highlight the lines; leave them out to show the top of the file. A directory path lists its entries.',
  'title is a 2-5 word step label ("Request enters handler"); note is a short markdown caption of what to look at.',
].join(' ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    await $.command.register({ name: 'github-browse', description: 'Open the GitHub code browser pane' })
    const started = await next(e)
    await $.tool.register({
      name: 'github_show',
      description: DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name; omit for local files' },
          path: { type: 'string', description: 'File or directory path; empty for the repo root' },
          ref: { type: 'string', description: 'Branch, tag or commit; default branch if omitted' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
          title: { type: 'string', description: 'Short step label for the trace bar' },
          note: { type: 'string', description: 'Short markdown caption shown above the code' },
          new_trace: { type: 'boolean', description: 'Start a fresh trace, clearing earlier steps' },
        },
      },
    })

    return started
  })

  on('command.run', { command: 'github-browse' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'GitHub browser opened.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ShowInput
    const where: Where = { repo: input.repo, ref: input.ref, path: clean(input) }
    const stop = await openStop($, where, {
      start: input.start_line,
      end: input.end_line,
      title: input.title,
      note: input.note,
      isUser: false,
    })
    await push($, stop, input.new_trace === true)
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: summarize(stop) }
  }).catch(() => ({ deny: 'The GitHub browser pane failed to update.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link, Code, Markdown } = els
    // The terminal has no Svg element. `'Svg' in els` is true there too, and the
    // unknown element draws as an empty fragment, so choose by surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const list = await read($, stops)
    const at = Math.min(await read($, cursor), list.length - 1)
    const working = await read($, busy)
    const stop = list[at]

    if (!stop) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Text weight="semibold">Code browser</Text>
          <Text dimColor>
            Ask Claude to debug or explain some code. Each step of its explanation shows up here as a numbered trace, with
            the lines it means highlighted. Click a function call to jump to its definition.
          </Text>
        </Box>
      )
    }

    const where: Where = { repo: stop.repo, ref: stop.ref, path: stop.path }
    const shown = shownPath(stop)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {stop.title ?? stop.repo ?? 'local'}
          </Text>
          <Text weight="semibold" wrap="truncate-start">
            {basename(shown)}
            {rangeLabel(stop) ? `:${rangeLabel(stop)}` : ''}
          </Text>
        </Box>
      )
    }

    const run = (label: string, work: () => Promise<void>) => () => {
      void (async () => {
        await update($, busy, () => label)
        try {
          await work()
        } catch (err) {
          $.ui.toast(err instanceof Error ? err.message : String(err))
        } finally {
          await update($, busy, () => '')
        }
      })()
    }
    const goTo = (i: number) => () => void update($, cursor, () => Math.max(0, Math.min(i, list.length - 1)))
    const browse = (to: Where, opts: Omit<OpenOpts, 'isUser'> = {}) =>
      run(`Opening ${basename(to.path) || to.repo || '.'}…`, async () => {
        await push($, await openStop($, to, { ...opts, isUser: true }), false)
      })
    const jumpTo = (name: string) =>
      run(`Finding ${name}…`, async () => {
        const hit = await findDefinition($, name, where)
        if (!hit) throw new Error(`Couldn't find where ${name} is defined.`)
        await push($, await openStop($, hit.where, { start: hit.line, isUser: true }), false)
      })
    const widen = run('Loading more…', async () => {
      const wider = await openStop($, where, {
        start: stop.startLine,
        end: stop.endLine,
        title: stop.title,
        note: stop.note,
        isUser: stop.isUser,
        context: stop.context + 25,
      })
      await update($, stops, all => all.map((s, i) => (i === at ? { ...wider, id: s.id } : s)))
    })

    const steps = list.map((s, i) => ({ s, i })).filter(x => !x.s.isUser)
    const crumbs = crumbsOf(stop, shown)
    const showOutline = await read($, outline)
    const toggleOutline = () => void update($, outline, v => !v)
    const hasCode = Boolean(stop.before || stop.focus)
    const canMore = hasCode && (stop.totalLines ?? 0) > visibleLines(stop)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {steps.map(({ s, i }, n) => (
            <Button key={`step-${s.id}`} plain dimColor={i !== at} onPress={goTo(i)}>
              {i === at ? `[${n + 1}]` : ` ${n + 1} `}
            </Button>
          ))}
          {stop.isUser && <Text dimColor>· browsing</Text>}
          <Box flexGrow={1} />
          {working !== '' && <Text dimColor>{working}</Text>}
          <Button key="back" hotkey="p" plain dimColor onPress={goTo(at - 1)}>
            ←
          </Button>
          <Button key="fwd" hotkey="n" plain dimColor onPress={goTo(at + 1)}>
            →
          </Button>
          {stop.url && <Link href={stop.url} label="↗" />}
        </Box>

        {(stop.title || stop.note) && (
          <Box flexDirection="column">
            {stop.title && <Text weight="semibold">{stop.title}</Text>}
            {stop.note && <Markdown text={stop.note} dimColor />}
          </Box>
        )}

        <Box flexDirection="row" flexWrap="wrap" alignItems="center">
          {crumbs.map((c, i) =>
            c.to ? (
              <Box key={`crumb-${i}`} flexDirection="row">
                <Button key={`crumb-b-${i}`} plain dimColor onPress={browse(c.to)}>
                  {c.label}
                </Button>
                <Text dimColor>/</Text>
              </Box>
            ) : (
              <Text>{c.label}</Text>
            ),
          )}
          {rangeLabel(stop) !== '' && <Text dimColor>{`  ${rangeLabel(stop)}`}</Text>}
        </Box>

        {stop.error && <Text color="error">{stop.error}</Text>}

        {stop.entries && (
          <Box flexDirection="column">
            {stop.entries.map(entry => (
              <Button key={`entry-${entry.name}`} plain onPress={browse({ ...where, path: join(stop.path, entry.name) })}>
                {entry.isDir ? `${entry.name}/` : entry.name}
              </Button>
            ))}
          </Box>
        )}

        {hasCode &&
          (Svg ? (
            (() => {
              const svg = codeSvg(stop, shown, e.props.bodyColumns)

              return <Svg source={svg.source} alt={`${shown} ${rangeLabel(stop)}`} />
            })()
          ) : (
            <Box flexDirection="column">
              {stop.before && (
                <Code source={stop.before.text} path={stop.path} startLine={stop.before.start} wrap="truncate-end" />
              )}
              {stop.focus && (
                <Box borderStyle="bold" borderColor="warning" flexDirection="column">
                  <Code source={stop.focus.text} path={stop.path} startLine={stop.focus.start} wrap="truncate-end" />
                </Box>
              )}
              {stop.after && (
                <Code source={stop.after.text} path={stop.path} startLine={stop.after.start} wrap="truncate-end" />
              )}
            </Box>
          ))}

        {hasCode && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            {(stop.calls ?? []).slice(0, 10).map(name => (
              <Button key={`call-${name}`} plain dimColor onPress={jumpTo(name)}>
                {`${name}()`}
              </Button>
            ))}
            <Box flexGrow={1} />
            {canMore && (
              <Button key="more" plain dimColor onPress={widen}>
                more
              </Button>
            )}
            {stop.symbols && stop.symbols.length > 0 && (
              <Button key="outline" plain dimColor onPress={toggleOutline}>
                {showOutline ? 'hide outline' : 'outline'}
              </Button>
            )}
          </Box>
        )}

        {showOutline && stop.symbols && stop.symbols.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {stop.symbols.slice(0, 80).map(sym => (
              <Button key={`sym-${sym.name}-${sym.line}`} plain dimColor onPress={browse(where, { start: sym.line })}>
                {sym.name}
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

async function push($: EngineInterface, stop: Stop, isNewTrace: boolean) {
  const at = await read($, cursor)
  const list = isNewTrace ? [] : await read($, stops)
  const base = stop.isUser ? list.slice(0, at + 1) : list
  const kept = [...base, stop].slice(-MAX_STOPS)
  await update($, stops, () => kept)
  await update($, cursor, () => kept.length - 1)
}

async function openStop($: EngineInterface, where: Where, opts: OpenOpts): Promise<Stop> {
  const context = opts.context ?? CONTEXT
  const base: Stop = {
    id: Date.now() + Math.random(),
    isUser: opts.isUser,
    repo: where.repo,
    ref: where.ref,
    path: where.path,
    title: opts.title,
    note: opts.note,
    context,
  }
  let start = opts.start
  let end = opts.end ?? start
  if (start && end && end < start) [start, end] = [end, start]

  try {
    const got = await fetchSource($, where)
    if ('entries' in got) return { ...base, entries: got.entries, url: url(where, 'tree') }

    const lines = got.text.replace(/\n$/, '').split('\n')
    const total = lines.length
    const slice = (from: number, to: number): Excerpt | undefined =>
      to >= from ? { start: from, text: lines.slice(from - 1, to).join('\n') } : undefined
    const stop: Stop = {
      ...base,
      totalLines: total,
      symbols: symbolsOf(got.text),
      url: url(where, 'blob', start, end),
    }

    if (!start) {
      const before = slice(1, Math.min(total, PREVIEW + context - CONTEXT))

      return { ...stop, before, calls: callsIn(before?.text ?? '') }
    }

    const s = Math.min(start, total)
    const t = Math.min(end ?? s, total, s + MAX_FOCUS - 1)
    const focus = slice(s, t)

    return {
      ...stop,
      startLine: s,
      endLine: t,
      before: slice(Math.max(1, s - context), s - 1),
      focus,
      after: slice(t + 1, Math.min(total, t + context)),
      calls: callsIn(focus?.text ?? ''),
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

function clean(input: ShowInput): string {
  const path = input.path ?? ''

  return input.repo ? path.replace(/^\/+|\/+$/g, '') : path || '.'
}

function shownPath(stop: Stop): string {
  if (stop.repo) return stop.path
  if (cwd && stop.path.startsWith(`${cwd}/`)) return stop.path.slice(cwd.length + 1)

  return stop.path === '.' ? '' : stop.path
}

function crumbsOf(stop: Stop, shown: string): { label: string; to?: Where }[] {
  const root = stop.repo ?? (stop.path.startsWith('/') && !shown.startsWith('/') ? basename(cwd) || '.' : '.')
  const rootPath = stop.repo ? '' : stop.path.startsWith('/') && shown !== stop.path ? cwd : '.'
  const parts = shown.split('/').filter(Boolean)
  const isAbs = !stop.repo && shown.startsWith('/')
  const crumbs: { label: string; to?: Where }[] = isAbs ? [] : [{ label: root, to: { repo: stop.repo, ref: stop.ref, path: rootPath } }]
  let acc = isAbs ? '' : rootPath === '.' ? '' : rootPath
  parts.forEach((p, i) => {
    acc = acc ? `${acc}/${p}` : isAbs ? `/${p}` : p
    const isLast = i === parts.length - 1
    crumbs.push(isLast && !stop.entries ? { label: p } : { label: p, to: { repo: stop.repo, ref: stop.ref, path: acc } })
  })
  if (stop.entries && crumbs.length > 0) {
    const last = crumbs[crumbs.length - 1]
    if (last) crumbs[crumbs.length - 1] = { label: last.label }
  }

  return crumbs
}

function visibleLines(stop: Stop): number {
  const n = (ex?: Excerpt) => (ex ? ex.text.split('\n').length : 0)

  return n(stop.before) + n(stop.focus) + n(stop.after)
}

function rangeLabel(stop: Stop): string {
  if (!stop.startLine) return ''

  return stop.endLine && stop.endLine !== stop.startLine ? `L${stop.startLine}–${stop.endLine}` : `L${stop.startLine}`
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? ''
}

function join(dir: string, name: string): string {
  if (!dir || dir === '.') return name

  return `${dir.replace(/\/+$/, '')}/${name}`
}

function url(where: Where, kind: 'blob' | 'tree', start?: number, end?: number) {
  if (!where.repo) return undefined
  const lines = start ? `#L${start}${end && end !== start ? `-L${end}` : ''}` : ''

  return `https://github.com/${where.repo}/${kind}/${where.ref ?? 'HEAD'}/${where.path}${lines}`
}

function summarize(stop: Stop): string {
  if (stop.error) return `Could not show ${stop.path}: ${stop.error}`
  const where = `${stop.repo ? `${stop.repo}:` : ''}${stop.path || '/'}`
  if (stop.entries) {
    return `Pane shows directory ${where} (${stop.entries.length} entries): ${stop.entries.map(x => x.name + (x.isDir ? '/' : '')).join(', ')}`
  }
  const range = stop.startLine ? ` lines ${stop.startLine}-${stop.endLine}` : ''
  const shown = stop.focus?.text ?? stop.before?.text ?? ''

  return `Pane shows ${where}${range} (${stop.totalLines} lines total). Highlighted text:\n${shown}`
}
