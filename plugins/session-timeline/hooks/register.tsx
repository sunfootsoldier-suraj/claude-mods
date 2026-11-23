import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRec, Entry, Live, Prefs, Status, ToolKind, Totals, View } from '../types'
import { advanceYard, newYard, PET_MS, rasterCells, svgSource } from './pets'
import type { PetMood, PetScene, PetTheme } from './pets'
import { CAST, castAt, castName, drawScene, portraitFor, portraitPixels, PORTRAIT_NAMES, PORTRAIT_W, sceneAlt, sceneTag } from './slayer'
import type { Portrait } from './slayer'

const PANE = 'timeline'
// Rows kept per session. The pane draws all of them and scrolls.
const MAX = 5000
const ACCENT = '#7aa2f7'
const GOOD = '#73c991'
const BAD = '#f7768e'
const AGENT = '#bb9af7'
const STORE_KEY = 'prefs-v4'
// Each session's rows live in the store under its own id, so a resume finds them.
const HISTORY_PREFIX = 'history:'
const HISTORY_KEEP = 30

const entries = atom({ plugin: 'session-timeline', key: 'entries' } as const, [] as Entry[])
const agents = atom({ plugin: 'session-timeline', key: 'agents' } as const, [] as AgentRec[])
const expanded = atom({ plugin: 'session-timeline', key: 'expanded' } as const, {} as Record<string, boolean>)
const live = atom({ plugin: 'session-timeline', key: 'live' } as const, {
  phase: 'idle',
  since: 0,
  turnStartedAt: 0,
  running: 0,
} as Live)
const totals = atom({ plugin: 'session-timeline', key: 'totals' } as const, {
  startedAt: 0,
  turns: 0,
  tools: 0,
  errors: 0,
  perTurn: [],
} as Totals)
const sessionId = atom({ plugin: 'session-timeline', key: 'sessionId' } as const, '')
const isQuiet = atom({ plugin: 'session-timeline', key: 'isQuiet' } as const, true)
const DEFAULT_PREFS: Prefs = {
  view: 'overview',
  isBandOn: true,
  isSubShown: false,
  isErrorsOnly: false,
  isClockTime: true,
  isRecentOnly: false,
  isKeysPinned: false,
  isSlowOnly: false,
  isAiOn: true,
  pet: 'slayer',
  isTurnSprites: true,
  cast: 'rotate',
  kind: 'all',
}
const prefs = atom({ plugin: 'session-timeline', key: 'prefs' } as const, DEFAULT_PREFS)

const SLOW_MS = 30_000
const KINDS: ToolKind[] = ['all', 'edits', 'commands', 'reads', 'agents', 'web']
const VIEWS: View[] = ['overview', 'deep', 'narrow']
const BARS = '▁▂▃▄▅▆▇█'
// Animation frame period. Frames advance only while something runs.
const TICK_MS = 500
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// Tool calls a running turn or subagent makes before the model labels it again.
const RELABEL_CALLS = 4
const RELABEL_MS = 15_000
// Restored turns the model labels after a resume, newest first.
const RESTORED_LABELS = 3

// ---- text -------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

function base(path: unknown): string {
  return typeof path === 'string' ? path.split('/').filter(Boolean).pop() ?? path : ''
}

// A short label for one tool call, from the fields the model sent.
function label(e: Record<string, unknown>): string {
  const pick = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  const raw =
    pick('description') ||
    base(e.file_path) ||
    base(e.notebook_path) ||
    pick('skill') ||
    pick('subject') ||
    pick('query') ||
    pick('pattern') ||
    pick('url') ||
    pick('command') ||
    pick('prompt') ||
    pick('task_id')
  return humanText(raw, 60)
}

// Blocks of machine text that a person never needs to read. The whole block goes.
const DROP_BLOCKS = [
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'bash-stdout',
  'bash-stderr',
  'command-message',
  'command-args',
  'tool-use-id',
  'output-file',
  'status',
  'task-id',
]

// Plain words only: no <tag> blocks, no [marker] lines, no markdown link syntax.
function humanText(text: string, max: number): string {
  let s = text
  for (const tag of DROP_BLOCKS) s = s.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g'), ' ')
  s = s.replace(/<\/?[a-zA-Z][\w-]*[^>]*>/g, ' ')
  s = s.replace(/\[([^\]\n]{1,80})\]\([^)\s]*\)/g, '$1')
  s = s.replace(/(^|\s)\[[^\]\n]{1,160}\]/g, '$1')
  s = s.replace(/`+/g, '')
  return oneLine(s, max)
}

const inside = (text: string, tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim()

// A prompt as a person reads it. Background notices keep only their summary.
function cleanPrompt(text: string, kind: string): { text: string; isAuto: boolean } {
  if (text.includes('<task-notification>')) {
    const summary = humanText(inside(text, 'summary') ?? '', 120)
    return { text: summary || 'A background task reported back', isAuto: true }
  }
  const command = inside(text, 'command-name')
  if (command) {
    const args = humanText(inside(text, 'command-args') ?? '', 80)
    return { text: oneLine(`Ran ${command}${args ? ` ${args}` : ''}`, 120), isAuto: false }
  }
  const shell = inside(text, 'bash-input')
  if (shell) return { text: oneLine(`Shell: ${shell}`, 120), isAuto: false }
  if (/^\s*\[Request interrupted by user/.test(text)) {
    return { text: 'You stopped Claude', isAuto: false }
  }
  const plain = humanText(text, 120)
  if (!plain) return { text: 'A background update', isAuto: true }
  const outside = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  const isSystem = /\[SYSTEM NOTIFICATION/.test(outside)
  return { text: plain, isAuto: isSystem || kind !== 'composer' }
}

// How a turn ended, in words. The engine's reason codes never reach the pane.
const ENDINGS: Record<string, string> = {
  answer: 'replied',
  replied: 'replied',
  stopped: 'stopped',
  aborted: 'stopped',
  max_tokens: 'hit the length limit',
  max_turns: 'hit the turn limit',
  error: 'ended on an error',
  refusal: 'declined',
}
const ending = (why: string) => ENDINGS[why] ?? why.replace(/[_-]+/g, ' ')

function clockTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// A duration in at most 3 characters, for a fixed column.
function short(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

function spark(values: number[], width: number): string {
  const tail = values.slice(-width)
  const top = Math.max(1, ...tail)
  return tail.map(v => BARS[Math.min(BARS.length - 1, Math.round((v / top) * (BARS.length - 1)))]).join('')
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function listNames(names: string[]): string {
  const uniq = [...new Set(names.filter(Boolean))]
  const shown = uniq.slice(0, 3)
  const more = uniq.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? ''
}

// Transcript rows the quiet mode hides: tool rows, durations, notices and the
// spinner. Your messages, Claude's replies and questions to you stay.
async function hideWhenQuiet($: any, e: any, next: any) {
  if (!(await read($, isQuiet))) return next(e)
  const { Box } = $.ui.resolve(e)
  return <Box />
}

// ---- the animation clock ----------------------------------------------------------

let ticker: { cancel: () => void } | undefined
let ticks = 0

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

// Redraw on each frame while the main loop or a subagent runs.
function startTicker($: any): void {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => {
    ticks += 1
    $.ui.invalidate('ui.render')
    if (ticks % 4 === 0) void pollAgents($)
  })
}

async function stopTickerWhenIdle($: any): Promise<void> {
  const l = await read($, live)
  const list = await read($, agents)
  if (l.phase === 'idle' && !list.some(x => x.status === 'run')) stopTicker()
}

// ---- tool kinds -------------------------------------------------------------------

function kindOf(tool: string): ToolKind | 'other' {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edits'
  if (['Bash', 'BashOutput', 'Monitor'].includes(tool)) return 'commands'
  if (['Read', 'Grep', 'Glob', 'LS'].includes(tool)) return 'reads'
  if (['Agent', 'Task'].includes(tool)) return 'agents'
  if (['WebFetch', 'WebSearch'].includes(tool) || tool.startsWith('mcp__')) return 'web'
  return 'other'
}

// One colour per tool kind, for the activity strips.
const KIND_TINT: Record<string, string> = {
  edits: '#e0af68',
  commands: ACCENT,
  reads: '#737aa2',
  agents: AGENT,
  web: '#7dcfff',
  other: '#9aa5ce',
}

function serverName(tool: string): string {
  const parts = tool.split('__')
  return (parts[1] ?? tool).replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')
}

// The tool name for a fixed column: connector tools show their server.
function toolName(tool: string): string {
  return tool.startsWith('mcp__') ? serverName(tool) : tool
}

// True when a tool row passes the active filters.
function isShown(x: Entry, p: Prefs): boolean {
  if (p.isErrorsOnly && x.status !== 'err') return false
  if (p.isSlowOnly && (x.ms ?? 0) < SLOW_MS && x.status !== 'run') return false
  if (p.kind !== 'all' && kindOf(x.tool ?? '') !== p.kind) return false
  return true
}

const isFiltered = (p: Prefs) => p.isErrorsOnly || p.isSlowOnly || p.kind !== 'all'

// Counts by kind, for one compact line: "4 commands · 2 edits · 3 reads".
function stats(tools: Entry[]): string {
  const own = tools.filter(x => !x.isSub)
  const count = (k: string) => own.filter(x => kindOf(x.tool ?? '') === k).length
  const parts = [
    [count('commands'), 'command', 'commands'],
    [count('edits'), 'edit', 'edits'],
    [count('reads'), 'read', 'reads'],
    [count('agents'), 'agent', 'agents'],
    [count('web'), 'web call', 'web calls'],
    [count('other'), 'other', 'other'],
  ] as const
  const out = parts.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many))
  const sub = tools.length - own.length
  if (sub) out.push(`${sub} by subagents`)
  return out.length ? out.join(' · ') : 'no tools'
}

// One plain sentence for one turn: what Claude did, what failed, how it ended.
function summarize(tools: Entry[], answer: Entry | undefined): string {
  const own = tools.filter(x => !x.isSub)
  const sub = tools.length - own.length
  const by = (k: string) => own.filter(x => kindOf(x.tool ?? '') === k)
  const parts: string[] = []
  if (by('commands').length) parts.push(`ran ${plural(by('commands').length, 'command', 'commands')}`)
  if (by('reads').length) parts.push(`looked at ${plural(by('reads').length, 'file', 'files')}`)
  if (by('edits').length) parts.push(`changed ${listNames(by('edits').map(x => x.text))}`)
  if (by('agents').length) parts.push(`started ${plural(by('agents').length, 'subagent', 'subagents')}`)
  if (by('web').length) parts.push(`used ${listNames(by('web').map(x => toolName(x.tool ?? '')))}`)
  if (by('other').length) parts.push(`used ${listNames(by('other').map(x => x.tool ?? ''))}`)
  if (sub) parts.push(`subagents made ${plural(sub, 'call', 'calls')}`)

  const failed = tools.filter(x => x.status === 'err').length
  let line = parts.length ? parts.join(', ') : 'answered without tools'
  line = line.charAt(0).toUpperCase() + line.slice(1) + '.'
  if (failed) line += ` ${failed} failed.`
  if (!answer) return `${line} Still working.`
  const how = ending(answer.text)
  const said = how.charAt(0).toUpperCase() + how.slice(1)
  if (answer.isRestored) return `${line} ${said}.`
  return `${line} ${said} after ${span(answer.ms ?? 0)}.`
}

// ---- few-word summaries from the model ---------------------------------------------

const LABEL_SYSTEM = [
  'You write a label for one step of work in a coding session.',
  'Write 3 to 6 words.',
  'Start with a verb in the -ing form.',
  'Name the concrete thing: the file, test, model, dataset or bug.',
  'Do not use quotes. Do not end with a full stop.',
  'Reply with the label only.',
].join('\n')

// Keys of labels in flight, and when each key last asked, by call count and time.
const asking = new Set<string>()
// A final label asked while another ask of the same key runs. It runs when that ends.
const pendingFinal = new Map<string, () => Promise<void>>()

function finishAsk(key: string): void {
  asking.delete(key)
  const queued = pendingFinal.get(key)
  pendingFinal.delete(key)
  if (queued) void queued()
}
const lastAsk = new Map<string, { at: number; calls: number }>()

function cleanLabel(text: string): string {
  const first = text.split('\n').map(x => x.trim()).find(Boolean) ?? ''
  return oneLine(first.replace(/^["'`*\-\s]+|["'`*.\s]+$/g, '').replace(/^label:\s*/i, ''), 56)
}

async function askLabel($: any, prompt: string): Promise<string | undefined> {
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: LABEL_SYSTEM,
      prompt,
      maxTokens: 40,
      effort: 'low',
      timeoutMs: 10_000,
    })
    if (!r?.isAnswered) return undefined
    return cleanLabel(String(r.text ?? '')) || undefined
  } catch {
    return undefined
  }
}

// True when a key may ask the model again: none in flight, and enough new work.
function isDue(key: string, calls: number, now: number, isFinal: boolean): boolean {
  if (asking.has(key)) return false
  if (isFinal) return true
  const was = lastAsk.get(key)
  if (!was) return calls >= 2
  return calls - was.calls >= RELABEL_CALLS && now - was.at >= RELABEL_MS
}

function stepLines(tools: Entry[], max: number): string {
  return tools
    .slice(-max)
    .map(x => `- ${toolName(x.tool ?? '?')}${x.status === 'err' ? ' (failed)' : ''}: ${x.text || '(no label)'}`)
    .join('\n')
}

// Label one main-loop turn. Final: what the turn did. Otherwise: what it does now.
async function labelTurn($: any, turn: number, isFinal: boolean, reply = ''): Promise<void> {
  if (!(await read($, prefs)).isAiOn) return
  const key = `turn:${turn}`
  const now = await $.clock.now()
  const list = await read($, entries)
  const prompt = list.find(x => x.kind === 'prompt' && x.turn === turn)
  if (!prompt) return
  const tools = list.filter(x => x.kind === 'tool' && x.turn === turn && !x.isSub)
  if (isFinal && asking.has(key)) {
    pendingFinal.set(key, () => labelTurn($, turn, true, reply))
    return
  }
  if (!isDue(key, tools.length, now, isFinal)) return
  const subs = (await read($, agents)).filter(x => x.turn === turn)
  asking.add(key)
  lastAsk.set(key, { at: now, calls: tools.length })
  const ask = [
    `Request from the person: ${prompt.text}`,
    tools.length ? `Tool calls, oldest first:\n${stepLines(tools, 30)}` : 'No tool calls.',
    subs.length ? `Subagents started: ${subs.map(x => x.description).join('; ')}` : '',
    reply ? `Start of the final reply: ${oneLine(reply, 400)}` : '',
    isFinal ? 'Write the label for what Claude did in this turn.' : 'Write the label for what Claude does now.',
  ]
    .filter(Boolean)
    .join('\n\n')
  const said = await askLabel($, ask)
  finishAsk(key)
  if (!said) return
  await update($, entries, all =>
    all.map(x => (x.kind === 'prompt' && x.turn === turn ? { ...x, summary: said, isAiSummary: true } : x)),
  )
  $.ui.invalidate('ui.render')
  // Save the final label, so a resume shows it.
  if (isFinal) await saveHistory($, await read($, sessionId))
}

// Label one subagent from its task and its recent calls.
async function labelAgent($: any, id: string, isFinal: boolean, reply = ''): Promise<void> {
  if (!(await read($, prefs)).isAiOn) return
  const key = `agent:${id}`
  const now = await $.clock.now()
  const rec = (await read($, agents)).find(x => x.id === id)
  if (!rec) return
  if (isFinal && asking.has(key)) {
    pendingFinal.set(key, () => labelAgent($, id, true, reply))
    return
  }
  if (!isDue(key, rec.calls, now, isFinal)) return
  const tools = (await read($, entries)).filter(x => x.kind === 'tool' && x.agentId === id)
  asking.add(key)
  lastAsk.set(key, { at: now, calls: rec.calls })
  const ask = [
    `Task of the subagent (${rec.type}): ${rec.description}`,
    tools.length ? `Its tool calls, oldest first:\n${stepLines(tools, 20)}` : 'No tool calls yet.',
    reply ? `Start of its report: ${oneLine(reply, 400)}` : '',
    isFinal ? 'Write the label for what the subagent did.' : 'Write the label for what the subagent does now.',
  ]
    .filter(Boolean)
    .join('\n\n')
  const said = await askLabel($, ask)
  finishAsk(key)
  if (!said) return
  await update($, agents, all => all.map(x => (x.id === id ? { ...x, summary: said, isAiSummary: true } : x)))
  $.ui.invalidate('ui.render')
}

// After a resume, label only the newest restored turns. Older turns keep the rule text.
async function labelRestored($: any): Promise<void> {
  const list = await read($, entries)
  const open = list.filter(x => x.kind === 'prompt' && !x.summary && !x.isAuto).slice(-RESTORED_LABELS)
  for (const x of open) await labelTurn($, x.turn, true)
}

// ---- subagents --------------------------------------------------------------------

// The record of a subagent, made from the engine's list when its first call comes
// before its spawn result. The spawn hook fills in the Agent call it belongs to.
async function ensureAgent($: any, id: string, turn: number, now: number): Promise<AgentRec> {
  const have = (await read($, agents)).find(x => x.id === id)
  if (have) return have
  let info: any
  try {
    info = (((await $.agent.list()) as any[]) ?? []).find(y => y.id === id)
  } catch {
    info = undefined
  }
  const rec: AgentRec = {
    id,
    toolUseId: '',
    turn,
    description: humanText(String(info?.description ?? ''), 80) || 'Subagent',
    type: String(info?.type ?? 'agent'),
    startedAt: now,
    status: 'run',
    calls: 0,
    failed: 0,
  }
  await update($, agents, list => (list.some(x => x.id === id) ? list : [...list, rec]))
  return (await read($, agents)).find(x => x.id === id) ?? rec
}

// A workflow agent that sends no end in this time counts as done.
const WORKFLOW_MAX_MS = 60 * 60_000

const DONE: Record<string, Status> = { completed: 'ok', idle: 'ok', failed: 'err', killed: 'err' }

// Mark the subagents that ended. The list is the engine's record of each loop.
async function pollAgents($: any): Promise<void> {
  const mine = await read($, agents)
  if (!mine.some(x => x.status === 'run')) {
    await stopTickerWhenIdle($)
    return
  }
  let infos: any[] = []
  try {
    infos = ((await $.agent.list()) as any[]) ?? []
  } catch {
    return
  }
  const now = await $.clock.now()
  const ended: string[] = []
  await update($, agents, all =>
    all.map(x => {
      if (x.status !== 'run') return x
      const info = infos.find(y => y.id === x.id)
      // The list does not name a workflow agent. Its turn.complete ends it, or the age limit.
      if (!info && x.workflow && now - x.startedAt < WORKFLOW_MAX_MS) return x
      const status = info ? DONE[info.status] : 'ok'
      if (!status) return x
      ended.push(x.id)
      return { ...x, status, endedAt: now }
    }),
  )
  for (const id of ended) void labelAgent($, id, true)
  await stopTickerWhenIdle($)
}

// ---- one session's history ----------------------------------------------------------

type Saved = { entries: Entry[]; totals: Totals; agents?: AgentRec[] }

const EMPTY_LIVE: Live = { phase: 'idle', since: 0, turnStartedAt: 0, running: 0 }

function countTotals(list: Entry[], startedAt: number): Totals {
  const turns = list.filter(x => x.kind === 'prompt').length
  const tools = list.filter(x => x.kind === 'tool')
  const perTurn: number[] = []
  for (const x of list) {
    if (x.kind === 'prompt') perTurn.push(0)
    else if (x.kind === 'tool') {
      if (!perTurn.length) perTurn.push(0)
      perTurn[perTurn.length - 1] = (perTurn[perTurn.length - 1] ?? 0) + 1
    }
  }
  return {
    startedAt,
    turns,
    tools: tools.length,
    errors: tools.filter(x => x.status === 'err').length,
    perTurn: perTurn.slice(-200),
  }
}

// User-role text the engine wrote, not the person: skill bodies, compact summaries,
// image notes and messages from other sessions.
function isMachineText(text: string): boolean {
  const head = text.trimStart().slice(0, 120)
  return (
    head.startsWith('Base directory for this skill') ||
    head.startsWith('This session is being continued from a previous conversation') ||
    head.startsWith('[Image') ||
    head.startsWith('Another Claude session sent a message') ||
    head.startsWith('Caveat: The messages below')
  )
}

// The rows of a session the timeline did not watch, read from its transcript. The
// transcript holds no times, so each row is marked as restored.
async function rebuildFromTranscript($: any): Promise<Entry[]> {
  const messages = (await $.session.messages()) as any[]
  const list: Entry[] = []
  let turn = 0
  let isOpen = false
  const close = () => {
    if (isOpen) list.push({ kind: 'answer', at: 0, turn, text: 'replied', isRestored: true })
    isOpen = false
  }
  let isAnswered = true
  for (const m of messages) {
    if (m.role === 'user') {
      if (!m.text?.trim() || isMachineText(m.text)) continue
      // Text that follows a prompt before any answer belongs to that prompt (a skill
      // body, a pasted rule set, an image note). It is not a new turn.
      if (!isAnswered) continue
      isAnswered = false
      close()
      turn += 1
      isOpen = true
      const clean = cleanPrompt(m.text, 'composer')
      list.push({ kind: 'prompt', at: 0, turn, text: clean.text, isAuto: clean.isAuto, isRestored: true })
      continue
    }
    isAnswered = true
    for (const u of m.toolUses ?? []) {
      const isAnswered = u.result !== undefined || u.text !== undefined || u.isError
      list.push({
        kind: 'tool',
        at: 0,
        turn,
        tool: u.tool,
        id: u.tool_use_id,
        text: label(u.input ?? {}),
        status: u.isError || !isAnswered ? 'err' : 'ok',
        isRestored: true,
      })
    }
  }
  close()
  return list.slice(-MAX)
}

async function saveHistory($: any, id: string): Promise<void> {
  if (!id) return
  const list = await read($, entries)
  if (!list.length) return
  const key = HISTORY_PREFIX + id
  const saved: Saved = { entries: list, totals: await read($, totals), agents: await read($, agents) }
  await $.store.set(key, saved)
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith(HISTORY_PREFIX) && k !== key)
  for (const old of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP + 1))) await $.store.delete(old)
}

let syncing: Promise<void> | undefined

// Make the rows belong to the session that runs now. A new process, a resume and a
// /clear each change the session id. Saved rows win, then the transcript.
async function syncSession($: any): Promise<void> {
  if (syncing) return syncing
  syncing = (async () => {
    const id = (await $.session.id()) as string
    const was = await read($, sessionId)
    if (was === id) return
    if (was) await saveHistory($, was)
    const startedAt = ((await $.session.usage())?.startedAt as number) || (await $.clock.now())
    const saved = (await $.store.get(HISTORY_PREFIX + id)) as Saved | undefined
    const list = saved?.entries?.length
      ? saved.entries.map(x => (x.status === 'run' ? { ...x, status: 'err' as const } : x))
      : await rebuildFromTranscript($)
    // An unanswered last turn of a saved history ended when its process ended.
    const last = list[list.length - 1]
    if (saved && last && last.kind !== 'answer') {
      list.push({ kind: 'answer', at: 0, turn: last.turn, text: 'stopped', isRestored: true })
    }
    const recs = (saved?.agents ?? []).map(x => (x.status === 'run' ? { ...x, status: 'err' as const } : x))
    stopTicker()
    await update($, entries, () => list)
    await update($, agents, () => recs)
    await update($, expanded, () => ({}))
    await update($, totals, () => countTotals(list, startedAt))
    await update($, live, () => EMPTY_LIVE)
    await update($, sessionId, () => id)
    $.ui.invalidate('ui.render')
    void labelRestored($)
  })().finally(() => {
    syncing = undefined
  })
  return syncing
}

// ---- grouping ---------------------------------------------------------------------

type Turn = { n: number; prompt?: Entry; tools: Entry[]; answer?: Entry }

function groupTurns(list: Entry[]): Turn[] {
  const turns: Turn[] = []
  const byN = new Map<number, Turn>()
  for (const x of list) {
    let t = turns[turns.length - 1]
    // A subagent's call joins the turn that started the subagent, even later on.
    if (x.kind === 'tool' && x.agentId && byN.has(x.turn)) {
      byN.get(x.turn)?.tools.push(x)
      continue
    }
    if (!t || t.n !== x.turn || (x.kind === 'prompt' && t.prompt)) {
      t = { n: x.turn, tools: [] }
      turns.push(t)
      byN.set(x.turn, t)
    }
    if (x.kind === 'prompt') t.prompt = x
    else if (x.kind === 'answer') t.answer = x
    else t.tools.push(x)
  }
  return turns
}

// Turns in a row that background notices started merge into one block.
type Block = { turns: Turn[]; isAuto: boolean }

function groupBlocks(turns: Turn[]): Block[] {
  const blocks: Block[] = []
  for (const t of turns) {
    const isAuto = Boolean(t.prompt?.isAuto)
    const last = blocks[blocks.length - 1]
    if (isAuto && last?.isAuto) last.turns.push(t)
    else blocks.push({ turns: [t], isAuto })
  }
  return blocks
}

// Calls in a row with the same tool merge into one step.
type Step = { tool: string; labels: string[]; ids: string[]; n: number; status: Status; ms: number; isSub: boolean }

function groupSteps(tools: Entry[]): Step[] {
  const steps: Step[] = []
  for (const x of tools) {
    const isSub = Boolean(x.isSub)
    const tool = isSub ? 'subagent' : toolName(x.tool ?? '?')
    const last = steps[steps.length - 1]
    const status = x.status ?? 'ok'
    // A failed call never merges with a call that passed, so a retry stays visible.
    // An Agent call never merges, so each subagent keeps its own lane.
    const isSame =
      last && last.tool === tool && last.isSub === isSub && (last.status === 'err') === (status === 'err') && tool !== 'Agent'
    if (last && isSame) {
      last.n += 1
      if (x.text) last.labels.push(x.text)
      if (x.id) last.ids.push(x.id)
      last.ms += x.ms ?? 0
      if (status === 'err' || (status === 'run' && last.status !== 'err')) last.status = status
    } else {
      steps.push({ tool, labels: x.text ? [x.text] : [], ids: x.id ? [x.id] : [], n: 1, status, ms: x.ms ?? 0, isSub })
    }
  }
  return steps
}

function stepLabel(s: Step): string {
  if (s.tool === 'subagent') return `${plural(s.n, 'call', 'calls')} inside subagents`
  const uniq = [...new Set(s.labels)]
  if (uniq.length <= 1) return uniq[0] ?? ''
  return `${uniq[uniq.length - 1]}, and ${uniq.length - 1} more`
}

function turnStatus(t: Turn): Status {
  if (!t.answer) return 'run'
  return t.tools.some(x => x.status === 'err') ? 'err' : 'ok'
}

const MARK = { run: '◌', ok: '✓', err: '✗' } as const
const TINT = { run: ACCENT, ok: GOOD, err: BAD } as const

// The turn's few words: the model's label, else the rule-based sentence.
function turnWords(t: Turn): { text: string; isAi: boolean } {
  if (t.prompt?.summary) return { text: t.prompt.summary, isAi: Boolean(t.prompt.isAiSummary) }
  return { text: summarize(t.tools, t.answer), isAi: false }
}

// The session as plain text, one turn per two lines, for the clipboard.
function sessionText(list: Entry[]): string {
  return groupTurns(list)
    .map(x => {
      const at = (x.prompt ? clockTime(x.prompt.at) : '').padEnd(5)
      const who = x.prompt?.isAuto ? 'Update: ' : ''
      const words = turnWords(x)
      const extra = words.isAi ? ` (${stats(x.tools)})` : ''
      return `${at} ${who}${x.prompt?.text ?? '(before the timeline started)'}\n      ${words.text}${extra}`
    })
    .join('\n')
}

// ---- preferences ------------------------------------------------------------------

const HELP = [
  'Views: o overview · d deep · n narrow · v next view',
  'Filters: e errors · s slow (30s+) · f tool type · a subagent calls · l last 5 turns',
  'Move: g jump to the end · h jump to the start · arrows scroll',
  'Other: p pets (slayer, cat, off) · y slayer (rotate, Inosuke, Tanjiro, Zenitsu, Nezuko, Rengoku, Giyu) · i turn portraits · m model labels · q quiet transcript · b status band · t clock or time ago · c copy · k pin keys',
  'A press on ▸ or ▾ opens or closes one turn. Tab walks these marks.',
  'The letter keys work from any place in the focused pane.',
  'Strip colours: blue command · yellow edit · grey read · violet agent · cyan web · red failed.',
  'The keys work while the pane has the focus (ctrl+x tab, or a click).',
  'From the prompt: /timeline <overview|deep|narrow|quiet|band|agents|errors|slow|filter [type]|clock|recent|copy|keys|labels|pets [slayer|cat|off]|cast [rotate|inosuke|tanjiro|zenitsu|nezuko|rengoku|giyu]|sprites>',
  'Turn portraits (6 by 2 cells). A turn that worked: Zenitsu (short), Tanjiro (1 min or 6 calls), Rengoku (5 min or 30 calls). Inosuke: the turn runs now.',
  'Demons when calls failed (10% or more): Rui (1), Akaza (2 to 4), Muzan (5 or more, or an error end).',
  'A crow marks a background update. Nezuko asleep marks a turn you stopped.',
  'Settings are saved between sessions.',
].join('\n')

const onOff = (b: boolean) => (b ? 'on' : 'off')

// One toggle, by name. The pane keys and /timeline <word> both come here.
async function applyPref($: any, word: string, surface?: any): Promise<string> {
  const said = await changePref($, word, surface)
  await $.store.set(STORE_KEY, { prefs: await read($, prefs), isQuiet: await read($, isQuiet) })
  return said
}

async function changePref($: any, word: string, surface?: any): Promise<string> {
  const w = word.trim().toLowerCase()
  if (w === 'copy' || w === 'c') {
    const text = sessionText(await read($, entries))
    if (!text) return 'Nothing to copy yet.'
    const done = await $.ui.copy({ text, surface })
    const said = done.isCopied ? 'Session summary copied.' : 'The copy failed on this surface.'
    $.ui.toast(said)
    return said
  }
  if (w === 'g' || w === 'end' || w === 'h' || w === 'start') {
    const to = w === 'g' || w === 'end' ? 'end' : 'start'
    await $.ui.scroll({ in: PANE, to })
    return `Timeline: ${to}.`
  }
  if (w === 'quiet' || w === 'q') {
    const q = await update($, isQuiet, x => !x)
    $.ui.invalidate('ui.render')
    return q ? 'Transcript: messages only.' : 'Transcript: tool rows and status lines shown.'
  }
  if (w === 'filter' || w === 'f' || w.startsWith('filter ')) {
    const want = w.split(/\s+/)[1] as ToolKind | undefined
    const p = await update($, prefs, x => ({
      ...x,
      kind: want && KINDS.includes(want) ? want : KINDS[(KINDS.indexOf(x.kind) + 1) % KINDS.length] ?? 'all',
    }))
    $.ui.invalidate('ui.render')
    return `Tool type: ${p.kind}.`
  }
  if (w === 'p' || w === 'pets' || w.startsWith('pet ') || w.startsWith('pets ')) {
    const want = w.split(/\s+/)[1] as Prefs['pet'] | undefined
    const order: Prefs['pet'][] = ['slayer', 'cat', 'off']
    const p = await update($, prefs, x => ({
      ...x,
      pet: want && order.includes(want) ? want : order[(order.indexOf(x.pet) + 1) % order.length] ?? 'slayer',
    }))
    $.ui.invalidate('ui.render')
    return `Pets: ${p.pet}.`
  }
  if (w === 'y' || w === 'cast' || w.startsWith('cast ')) {
    const want = w.split(/\s+/)[1] as Prefs['cast'] | undefined
    const order: Prefs['cast'][] = ['rotate', ...CAST]
    const p = await update($, prefs, x => ({
      ...x,
      cast: want && order.includes(want) ? want : order[(order.indexOf(x.cast ?? 'rotate') + 1) % order.length] ?? 'rotate',
    }))
    $.ui.invalidate('ui.render')
    return p.cast === 'rotate' ? 'Slayer: the cast rotates.' : `Slayer: ${castName(p.cast)}.`
  }
  const views: Record<string, View> = { o: 'overview', overview: 'overview', d: 'deep', deep: 'deep', n: 'narrow', narrow: 'narrow' }
  if (views[w] || w === 'v' || w === 'view') {
    const p = await update($, prefs, x => ({
      ...x,
      view: views[w] ?? VIEWS[(VIEWS.indexOf(x.view) + 1) % VIEWS.length] ?? 'overview',
    }))
    // A new view sets every turn back to its default open or closed state.
    await update($, expanded, () => ({}))
    $.ui.invalidate('ui.render')
    return `Timeline view: ${p.view}.`
  }
  const flips: Record<string, [keyof Prefs, string]> = {
    band: ['isBandOn', 'Status band'],
    b: ['isBandOn', 'Status band'],
    agents: ['isSubShown', 'Subagent calls'],
    a: ['isSubShown', 'Subagent calls'],
    errors: ['isErrorsOnly', 'Errors only'],
    e: ['isErrorsOnly', 'Errors only'],
    slow: ['isSlowOnly', 'Slow calls only'],
    s: ['isSlowOnly', 'Slow calls only'],
    clock: ['isClockTime', 'Clock time'],
    t: ['isClockTime', 'Clock time'],
    recent: ['isRecentOnly', 'Last 5 turns only'],
    l: ['isRecentOnly', 'Last 5 turns only'],
    keys: ['isKeysPinned', 'Key bar pinned'],
    k: ['isKeysPinned', 'Key bar pinned'],
    sprites: ['isTurnSprites', 'Turn portraits'],
    i: ['isTurnSprites', 'Turn portraits'],
    labels: ['isAiOn', 'Model labels'],
    m: ['isAiOn', 'Model labels'],
  }
  const flip = flips[w]
  if (!flip) return HELP
  const [key, name] = flip
  const p = await update($, prefs, x => ({ ...x, [key]: !x[key] }))
  $.ui.invalidate('ui.render')
  return `${name}: ${onOff(Boolean(p[key]))}.`
}

async function toggleTurn($: any, n: number, isOpenNow: boolean): Promise<void> {
  await update($, expanded, x => ({ ...x, [String(n)]: !isOpenNow }))
  $.ui.invalidate('ui.render')
}

// ---- pets -------------------------------------------------------------------------

// What the pets act out. The pane writes it at each draw. The pet clock reads it.
type PetFacts = {
  theme: PetTheme
  phase: Live['phase']
  tool: string
  failAt: number
  doneAt: number
  idleSince: number
  slimes: string[]
  swarm: number
  cast: Prefs['cast']
  turn: number
  turnStartedAt: number
}

const yard = newYard()
let facts: PetFacts = { theme: 'slayer', phase: 'idle', tool: '', failAt: 0, doneAt: 0, idleSince: 0, slimes: [], swarm: 0, cast: 'rotate', turn: 0, turnStartedAt: 0 }
let petClock: { cancel: () => void } | undefined
let yardWidth = 0
let lastCells = ''
const SAD_MS = 4000
const HAPPY_MS = 3000
const SLEEP_MS = 120_000

function stopPets(): void {
  petClock?.cancel()
  petClock = undefined
}

function moodOf(f: PetFacts, now: number): PetMood {
  if (f.failAt && now - f.failAt < SAD_MS) return 'sad'
  if (f.phase === 'tool') {
    const k = kindOf(f.tool)
    return k === 'edits' ? 'type' : k === 'reads' ? 'read' : k === 'commands' ? 'run' : 'walk'
  }
  if (f.phase === 'working') return 'think'
  if (f.doneAt && now - f.doneAt < HAPPY_MS) return 'happy'
  if (f.slimes.length) return 'walk'
  if (f.idleSince && now - f.idleSince > SLEEP_MS) return 'sleep'
  return 'idle'
}

function sceneAt(now: number): PetScene {
  const mood = moodOf(facts, now)
  // The cast keeps the turn's slayer through the jump at the end of the turn.
  const isBusy = facts.phase !== 'idle' || facts.slimes.length > 0 || mood === 'happy' || mood === 'sad'
  const at = facts.phase === 'idle' && facts.doneAt ? facts.doneAt : now
  const who = castAt({ pin: facts.cast, isBusy, turn: facts.turn, turnStartedAt: facts.turnStartedAt, now: at })
  return { theme: facts.theme, mood, slimes: facts.slimes, who, swarm: facts.swarm }
}

// The terminal pets move between pane draws: each frame repaints the Raster alone.
function startPets($: any): void {
  if (petClock) return
  petClock = $.clock.every(PET_MS, async () => {
    if (!yardWidth) return
    const now = await $.clock.now()
    const scene = sceneAt(now)
    advanceYard(yard, scene.mood, yardWidth, now)
    const r = rasterCells(drawScene(yard, scene, yardWidth))
    if (r.cells === lastCells) return
    lastCells = r.cells
    const done = await $.ui.blit({ requestId: PANE, key: 'yard', cells: r.cells, columns: r.columns, rows: r.rows })
    // Not mounted, or another size: stop. The next pane draw starts the clock again.
    if (done?.deny) stopPets()
  })
}

// The portraits never change, so each frame is made once.
const faceCache = new Map<string, { cells: string; columns: number; rows: number }>()
const svgCache = new Map<string, string>()

function faceCells(kind: Portrait, f: number) {
  const k = `${kind}:${f}`
  let r = faceCache.get(k)
  if (!r) faceCache.set(k, (r = rasterCells(portraitPixels(kind, f))))
  return r
}

function faceSvg(kind: Portrait, f: number): string {
  const k = `${kind}:${f}`
  let r = svgCache.get(k)
  if (!r) svgCache.set(k, (r = svgSource(portraitPixels(kind, f), 3)))
  return r
}

// ---- hooks ------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await syncSession($)
    const saved = (await $.store.get(STORE_KEY)) as { prefs?: Partial<Prefs>; isQuiet?: boolean } | undefined
    // Defaults go under the held value, so a field added by a new version is set.
    await update($, prefs, p => ({ ...DEFAULT_PREFS, ...p, ...(saved?.prefs ?? {}) }))
    if (typeof saved?.isQuiet === 'boolean') await update($, isQuiet, () => saved.isQuiet as boolean)
    await $.command.register({
      name: 'timeline',
      description: 'Open the timeline, or set a view or toggle (run /timeline help for the list)',
    })
    await $.command.register({
      name: 'timeline-quiet',
      description: 'Show or hide tool rows and status lines in the transcript',
    })
    void $.ui.open({ id: PANE, title: 'Timeline' })
    return started
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    if (e.args.trim()) return { text: await applyPref($, e.args) }
    const opened = await $.ui.open({ id: PANE, title: 'Timeline' })
    return { text: opened.isPlaced ? `Timeline open.\n${HELP}` : 'Timeline waits for a wider terminal.' }
  })

  on('command.run', { command: 'timeline-quiet' }, async $ => ({ text: await applyPref($, 'quiet') }))

  on('prompt.submit', async ($, e, next) => {
    await syncSession($)
    const now = await $.clock.now()
    const t = await update($, totals, x => ({ ...x, turns: x.turns + 1, perTurn: [...x.perTurn, 0].slice(-200) }))
    const clean = cleanPrompt(e.text, e.origin.kind)
    await update($, entries, list =>
      [...list, { kind: 'prompt', at: now, turn: t.turns, text: clean.text, isAuto: clean.isAuto } as Entry].slice(-MAX),
    )
    await update($, live, () => ({ phase: 'working', since: now, turnStartedAt: now, running: 0 }))
    startTicker($)
    return next(e)
  })

  // A subagent starts: record it under the turn that started it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!r || r.deny !== undefined || !r.agentId) return r
    const now = await $.clock.now()
    const t = await read($, totals)
    const id = r.agentId
    const fields = {
      toolUseId: e.tool_use_id,
      description: humanText(e.description ?? '', 80) || 'Subagent',
      type: e.subagentType ?? (e.workflow ? 'workflow' : 'agent'),
      workflow: e.workflow?.runId || undefined,
    }
    // Its first calls may have made the record already: keep their counts.
    await update($, agents, list =>
      list.some(x => x.id === id)
        ? list.map(x => (x.id === id ? { ...x, ...fields } : x))
        : [...list, { id, ...fields, turn: t.turns, startedAt: now, status: 'run' as const, calls: 0, failed: 0 }],
    )
    startTicker($)
    $.ui.invalidate('ui.render')
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) await syncSession($)
    const now = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${now}`
    const t = await read($, totals)
    const rec = e.agentId ? await ensureAgent($, e.agentId, t.turns, now) : undefined
    const text = label(e as unknown as Record<string, unknown>)
    const entry: Entry = {
      kind: 'tool',
      at: now,
      turn: rec?.turn ?? t.turns,
      text,
      tool: e.tool,
      id,
      isSub: Boolean(e.agentId),
      agentId: e.agentId,
      status: 'run',
    }
    await update($, entries, list => [...list, entry].slice(-MAX))
    await update($, totals, x => {
      const perTurn = x.perTurn.length ? [...x.perTurn] : [0]
      perTurn[perTurn.length - 1] = (perTurn[perTurn.length - 1] ?? 0) + 1
      return { ...x, tools: x.tools + 1, perTurn }
    })
    if (rec) {
      // A call from a subagent that ended means it runs again (a message woke it).
      await update($, agents, list =>
        list.map(x => (x.id === rec.id ? { ...x, calls: x.calls + 1, status: 'run' as const, endedAt: undefined } : x)),
      )
      startTicker($)
    } else {
      await update($, live, l => ({ ...l, phase: 'tool' as const, tool: e.tool, label: text, since: now, running: l.running + 1 }))
    }

    const ran = await next(e)

    const done = await $.clock.now()
    const failed = ran.deny !== undefined || ran.isError === true
    await update($, entries, list =>
      list.map(x => (x.id === id ? { ...x, status: failed ? ('err' as const) : ('ok' as const), ms: done - now } : x)),
    )
    if (failed) await update($, totals, x => ({ ...x, errors: x.errors + 1 }))
    if (rec) {
      if (failed) await update($, agents, list => list.map(x => (x.id === rec.id ? { ...x, failed: x.failed + 1 } : x)))
      void labelAgent($, rec.id, false)
    } else {
      await update($, live, l => {
        const running = Math.max(0, l.running - 1)
        return running > 0 ? { ...l, running } : { ...l, running, phase: 'working' as const, tool: undefined, label: undefined, since: done }
      })
      void labelTurn($, entry.turn, false)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const reply = typeof e.answer === 'string' ? e.answer : ''
    const now = await $.clock.now()
    if (e.agentId) {
      // One run of the subagent's loop ended. A message may wake it again later.
      const status: Status = e.isAborted || e.reason === 'error' ? 'err' : 'ok'
      await update($, agents, list => list.map(x => (x.id === e.agentId ? { ...x, status, endedAt: now } : x)))
      void labelAgent($, e.agentId, true, reply)
      $.ui.invalidate('ui.render')
      await stopTickerWhenIdle($)
      return result
    }
    const t = await read($, totals)
    const why = e.isAborted ? 'stopped' : ending(e.reason ?? 'answer')
    await update($, entries, list =>
      [...list, { kind: 'answer', at: now, turn: t.turns, text: why, ms: e.durationMs } as Entry].slice(-MAX),
    )
    await update($, live, l => ({ ...l, phase: 'idle' as const, since: now, tool: undefined, label: undefined, running: 0 }))
    await stopTickerWhenIdle($)
    $.ui.invalidate('ui.render')
    await saveHistory($, await read($, sessionId))
    void labelTurn($, t.turns, true, reply)
    return result
  })

  // Save the rows when a session ends. After a /clear or a resume the process goes on
  // under another id, and no session.start fires, so the timer picks up the new one.
  on('session.end', async ($, e, next) => {
    await saveHistory($, e.sessionId)
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, sessionId, () => '')
      $.clock.after(1500, () => void syncSession($))
    }
    return next(e)
  })

  // Quiet transcript: draw nothing for tool rows and status lines.
  on('ui.render', { component: 'ToolUse' }, hideWhenQuiet)
  on('ui.render', { component: 'ToolResult' }, hideWhenQuiet)
  on('ui.render', { component: 'ToolGroup' }, hideWhenQuiet)
  on('ui.render', { component: 'ToolProgress' }, hideWhenQuiet)
  on('ui.render', { component: 'TurnDuration' }, hideWhenQuiet)
  on('ui.render', { component: 'InfoNotice' }, hideWhenQuiet)
  on('ui.render', { component: 'Spinner' }, hideWhenQuiet)

  // Bottom band: one fixed line. Working: elapsed, current step, calls this
  // turn. Ready: how the last turn went, and how long ago it ended.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (!(await read($, prefs)).isBandOn) return next(e)
    // Another mod's band (for example btw-panel) draws under this line.
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, live)
    const t = await read($, totals)
    const list = await read($, entries)
    const subs = (await read($, agents)).filter(x => x.status === 'run')
    const now = await $.clock.now()
    const thisTurn = list.filter(x => x.kind === 'tool' && x.turn === t.turns && !x.isSub)
    const calls = thisTurn.length
    const failed = thisTurn.filter(x => x.status === 'err').length
    const words = list.find(x => x.kind === 'prompt' && x.turn === t.turns)?.summary
    const bar = <Text dimColor>  │  </Text>
    const agentsNote = subs.length ? (
      <Text color={AGENT}>
        {'  │  '}◆ {plural(subs.length, 'subagent', 'subagents')} running
      </Text>
    ) : (
      ''
    )

    if (l.phase === 'idle') {
      const last = list.filter(x => x.kind === 'answer').pop()
      return (
        <Box flexDirection="column">
          <Box>
            <Text wrap="truncate-end">
              <Text color={GOOD} bold>✓ Ready</Text>
              {last ? bar : ''}
              {last ? <Text dimColor>last turn {span(last.ms ?? 0)} · {plural(calls, 'call', 'calls')}</Text> : ''}
              {failed ? <Text color={BAD}> · {failed} failed</Text> : ''}
              {words ? bar : ''}
              {words ? <Text>{words}</Text> : ''}
              {agentsNote}
            </Text>
          </Box>
          {below}
        </Box>
      )
    }
    const dots = SPIN[Math.floor(now / TICK_MS) % SPIN.length] ?? '◌'
    const step =
      l.phase === 'tool' ? (
        <Text>
          <Text bold>{toolName(l.tool ?? '')}</Text>
          {l.running > 1 ? <Text dimColor> ×{l.running}</Text> : ''}
          {l.label ? <Text dimColor> · {oneLine(l.label, 50)}</Text> : ''}
          <Text dimColor> · {span(now - l.since)}</Text>
        </Text>
      ) : (
        <Text dimColor>thinking · {span(now - l.since)}</Text>
      )
    return (
      <Box flexDirection="column">
        <Box>
          <Text wrap="truncate-end">
            <Text color={ACCENT} bold>{dots} Working {span(now - l.turnStartedAt)}</Text>
            {words ? bar : ''}
            {words ? <Text>{words}</Text> : ''}
            {bar}
            {step}
            {bar}
            <Text dimColor>{plural(calls, 'call', 'calls')} this turn</Text>
            {failed ? <Text color={BAD}> · {failed} failed</Text> : ''}
            {agentsNote}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })

  // Right pane. Each turn: the prompt, a few words from the model, then the steps.
  // Overview opens the running turn. Deep opens every turn. Narrow shows the words only.
  // The tree holds every turn. The pane scrolls it and follows the end.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const recs = await read($, agents)
    const opened = await read($, expanded)
    const t = await read($, totals)
    const p = await read($, prefs)
    const l = await read($, live)
    const quiet = await read($, isQuiet)
    const now = await $.clock.now()
    const full = Math.max(28, (e.props.bodyColumns ?? e.viewport?.columns ?? 48) - 1)
    const hasPixels = e.surface === 'terminal' || e.surface === 'desktop' || e.surface === 'mobile'
    const isFaces = p.isTurnSprites && hasPixels && full >= 40
    // The portrait column takes 7 cells from each turn's text.
    const width = isFaces ? full - (PORTRAIT_W + 1) : full
    const isKeysShown = p.isKeysPinned || e.props.isFocused
    const when = (at: number) => (!at ? '' : p.isClockTime ? clockTime(at) : short(now - at)).padEnd(6)
    const frame = Math.floor(now / TICK_MS)
    const spin = SPIN[frame % SPIN.length] ?? '◌'
    const pulse = frame % 2 === 0 ? '◉' : '○'
    const RAIL = '      │ '
    const LANE = '      │     '
    const labelRoom = width - RAIL.length - 15
    const byTool = new Map(recs.map(x => [x.toolUseId, x]))

    let turns = groupTurns(list)
    if (isFiltered(p)) turns = turns.filter(x => x.tools.some(y => isShown(y, p)))
    if (p.isRecentOnly) turns = turns.slice(-5)
    const blocks = groupBlocks(turns)

    // One coloured cell per tool call, newest last. Runs of one colour share a Text.
    const strip = (tools: Entry[], max: number) => {
      const tail = tools.slice(-max)
      const cells = tail.map(x => ({
        color: x.status === 'err' ? BAD : KIND_TINT[kindOf(x.tool ?? '')] ?? KIND_TINT.other,
        ch: x.status === 'run' ? spin : '■',
      }))
      const runs: { color: string; text: string }[] = []
      for (const c of cells) {
        const last = runs[runs.length - 1]
        if (last && last.color === c.color) last.text += c.ch
        else runs.push({ color: c.color as string, text: c.ch })
      }
      return runs.map((r, i) => (
        <Text key={`c${i}`} color={r.color}>
          {r.text}
        </Text>
      ))
    }

    const stepRow = (s: Step, prefix: string) => (
      <Text wrap="truncate-end">
        <Text dimColor>{prefix}</Text>
        <Text color={TINT[s.status]}>{s.status === 'run' ? spin : MARK[s.status]} </Text>
        <Text dimColor={s.isSub}>{oneLine(s.tool, 8).padEnd(9)}</Text>
        <Text dimColor>{(s.status === 'run' || s.ms < 1000 ? '' : short(s.ms)).padStart(3)} </Text>
        <Text dimColor>
          {s.n > 1 ? `×${s.n} ` : ''}
          {oneLine(stepLabel(s), labelRoom)}
        </Text>
      </Text>
    )

    // A subagent lane: its type and task, its live few words, its strip, its calls.
    const laneRows = (rec: AgentRec, calls: Entry[], isDeep: boolean): any[] => {
      const out: any[] = []
      const isRun = rec.status === 'run'
      const took = span((rec.endedAt ?? now) - rec.startedAt)
      out.push(
        <Text wrap="truncate-end">
          <Text dimColor>{RAIL}  </Text>
          <Text color={AGENT} bold>
            {isRun ? (frame % 2 === 0 ? '◆' : '◇') : '◆'} {oneLine(rec.type, 18)}
          </Text>
          <Text dimColor> · {oneLine(rec.description, Math.max(10, width - 34))}</Text>
        </Text>,
      )
      const words = rec.summary ?? (isRun ? 'Starting' : rec.status === 'err' ? 'Stopped' : 'Done')
      out.push(
        <Text wrap="truncate-end">
          <Text dimColor>{LANE}</Text>
          <Text color={TINT[rec.status]}>{isRun ? spin : MARK[rec.status]} </Text>
          <Text bold={Boolean(rec.isAiSummary)} dimColor={!rec.isAiSummary}>
            {oneLine(words, Math.max(10, width - LANE.length - 22))}
          </Text>
          <Text dimColor>
            {' '}· {took} · {plural(rec.calls, 'call', 'calls')}
          </Text>
          {rec.failed ? <Text color={BAD}> · {rec.failed} failed</Text> : ''}
        </Text>,
      )
      if (calls.length) {
        out.push(
          <Text wrap="truncate-end">
            <Text dimColor>{LANE}  </Text>
            {strip(calls, Math.max(8, width - LANE.length - 4))}
          </Text>,
        )
      }
      // The subagent's own calls: all in deep view with subagent calls on, the
      // newest three while it runs, none once it ended in the overview.
      const shown = calls.filter(x => isShown(x, p))
      const steps = groupSteps(shown.map(x => ({ ...x, isSub: false })))
      const tail = isDeep && p.isSubShown ? steps : isRun ? steps.slice(-3) : []
      if (tail.length < steps.length && tail.length) {
        out.push(<Text dimColor>{LANE}  … {plural(steps.length - tail.length, 'earlier step', 'earlier steps')}</Text>)
      }
      for (const s of tail) out.push(stepRow(s, `${LANE}  `))
      return out
    }

    const headRow = (x: Turn, isOpen: boolean, canOpen: boolean) => (
      <Box flexDirection="row">
        {canOpen ? (
          <Button key={`turn-${x.n}`} plain dimColor onPress={() => void toggleTurn($, x.n, isOpen)}>
            {isOpen ? '▾' : '▸'}
          </Button>
        ) : (
          <Text dimColor>·</Text>
        )}
        <Text wrap="truncate-end">
          <Text dimColor> {when(x.prompt?.at ?? x.tools[0]?.at ?? now)}</Text>
          <Text bold>{oneLine(x.prompt?.text ?? '(before the timeline started)', width - 9)}</Text>
        </Text>
      </Box>
    )

    const wordsRow = (x: Turn, isWrapped: boolean) => {
      const st = turnStatus(x)
      const words = turnWords(x)
      const node = st === 'run' ? pulse : '●'
      return (
        <Box flexDirection="row" paddingLeft={6}>
          <Text color={TINT[st]}>{node} </Text>
          <Text wrap={isWrapped ? 'wrap' : 'truncate-end'} bold={words.isAi} dimColor={!words.isAi} color={words.isAi ? undefined : st === 'err' ? BAD : undefined}>
            {words.text}
          </Text>
        </Box>
      )
    }

    const statRow = (x: Turn, prefix: string) => {
      const st = turnStatus(x)
      const failed = x.tools.filter(y => y.status === 'err').length
      const took = x.answer
        ? x.answer.isRestored
          ? 'earlier session'
          : span(x.answer.ms ?? 0)
        : x.prompt && !x.prompt.at
          ? 'interrupted'
          : span(now - (x.prompt?.at ?? now))
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{prefix}</Text>
          <Text color={TINT[st]}>{st === 'run' ? spin : MARK[st]} </Text>
          <Text dimColor>{took} </Text>
          {x.tools.length ? strip(x.tools, 16) : ''}
          <Text dimColor> {stats(x.tools)}</Text>
          {failed ? <Text color={BAD}> · {failed} failed</Text> : ''}
        </Text>
      )
    }

    const autoRow = (b: Block) => {
      const last = b.turns[b.turns.length - 1]
      const tools = b.turns.flatMap(x => x.tools)
      const head = b.turns.length > 1 ? `${b.turns.length} updates, latest: ` : 'Update: '
      const ai = last?.prompt?.isAiSummary ? last.prompt.summary : undefined
      return (
        <Text wrap="truncate-end" dimColor>
          {'  '}
          {when(b.turns[0]?.prompt?.at ?? now)}↻ {head}
          {oneLine(last?.prompt?.text ?? '', width - 30)}
          {ai ? ` · ${ai}` : ''}
          {tools.length ? ` · ${plural(tools.length, 'call', 'calls')}` : ''}
        </Text>
      )
    }

    // A portrait beside each turn: who it shows depends on how the turn went.
    // Two turns can share a turn number (a new prompt in the same turn), so the key adds the row slot.
    const withPortrait = (x: Turn, out: any[], slot: number) => {
      if (!isFaces) return <Box flexDirection="column">{out}</Box>
      const all = x.tools
      const kind = portraitFor({
        isRunning: !x.answer && Boolean(x.prompt?.at),
        isAuto: Boolean(x.prompt?.isAuto),
        isStopped: x.answer?.text === 'stopped',
        isErrorEnd: x.answer?.text === ending('error'),
        calls: all.length,
        failed: all.filter(y => y.status === 'err').length,
        ms: x.answer ? (x.answer.ms ?? 0) : now - (x.prompt?.at || now),
      })
      const f = kind === 'fighter' ? frame % 2 : 0
      return (
        <Box flexDirection="row">
          <Box width={PORTRAIT_W + 1} flexShrink={0}>
            {portraitElement(kind, f, `face-${x.n}-${slot}`)}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {out}
          </Box>
        </Box>
      )
    }
    const portraitElement = (kind: Portrait, f: number, key: string) => {
      const { Raster, Svg } = $.ui.resolve(e) as any
      if (e.surface === 'terminal') {
        const r = faceCells(kind, f)
        return <Raster key={key} columns={r.columns} rows={r.rows} cells={r.cells} />
      }
      return <Svg source={faceSvg(kind, f)} alt={PORTRAIT_NAMES[kind]} width={PORTRAIT_W * 3} height={12} />
    }

    const rows: any[] = []
    blocks.forEach((b, i) => {
      const isLast = i === blocks.length - 1
      if (b.isAuto && !(p.view === 'deep' && isLast)) {
        rows.push(autoRow(b))
        return
      }
      for (const x of b.turns) {
        const out: any[] = []
        turnRows(x, isLast, b, out)
        rows.push(withPortrait(x, out, rows.length))
      }
    })

    function turnRows(x: Turn, isLast: boolean, b: Block, rows: any[]): void {
      {
        const isLastTurn = isLast && x === b.turns[b.turns.length - 1]
        const own = x.tools.filter(y => !y.isSub)
        const canOpen = p.view !== 'narrow' && x.tools.length > 0
        const isDefaultOpen = p.view === 'deep' || (isLastTurn && (!x.answer || isFiltered(p)))
        const isOpen = canOpen && (opened[String(x.n)] ?? isDefaultOpen)
        rows.push(headRow(x, isOpen, canOpen))
        rows.push(wordsRow(x, p.view === 'narrow'))
        if (p.view === 'narrow') return
        if (!isOpen) {
          rows.push(statRow(x, '      └ '))
          return
        }
        // Main-loop steps. Each Agent step carries the lanes of the subagents it started.
        const steps = groupSteps(own.filter(y => isShown(y, p)))
        const laneIds = new Set<string>()
        for (const s of steps) {
          rows.push(stepRow(s, RAIL))
          if (s.tool !== 'Agent') continue
          for (const id of s.ids) {
            const rec = byTool.get(id)
            if (!rec) continue
            laneIds.add(rec.id)
            const calls = x.tools.filter(y => y.agentId === rec.id)
            rows.push(...laneRows(rec, calls, p.view === 'deep'))
          }
        }
        // Subagents of this turn whose Agent call is not on screen get their lane here.
        for (const rec of recs) {
          if (rec.turn !== x.n || laneIds.has(rec.id)) continue
          laneIds.add(rec.id)
          rows.push(...laneRows(rec, x.tools.filter(y => y.agentId === rec.id), p.view === 'deep'))
        }
        // Subagent calls with no lane (an older history) keep one merged row.
        const loose = x.tools.filter(y => y.isSub && !(y.agentId && laneIds.has(y.agentId)) && isShown(y, p))
        for (const s of groupSteps(loose)) rows.push(stepRow(s, RAIL))
        rows.push(statRow(x, '      └ '))
      }
    }

    const flags = [
      p.isErrorsOnly ? 'errors' : '',
      p.isSlowOnly ? 'slow' : '',
      p.kind !== 'all' ? p.kind : '',
      p.isRecentOnly ? 'last 5' : '',
    ].filter(Boolean)

    const key = (k: string, name: string, isOn: boolean) => (
      <Button key={`key-${k}`} hotkey={k} plain dimColor={!isOn} onPress={press => void applyPref($, k, press.surface)}>
        {name}
      </Button>
    )
    const ruleWidth = Math.min(width, 64)
    const rule = <Text dimColor>{'─'.repeat(ruleWidth)}</Text>

    // The pet yard: a cat for the main loop and a slime for each running subagent.
    const lastErr = list.filter(x => x.kind === 'tool' && x.status === 'err' && !x.isSub).pop()
    const lastEnd = list.filter(x => x.kind === 'answer' && x.at).pop()
    facts = {
      theme: p.pet === 'cat' ? 'cat' : 'slayer',
      phase: l.phase,
      tool: l.tool ?? '',
      failAt: lastErr ? lastErr.at + (lastErr.ms ?? 0) : 0,
      doneAt: lastEnd?.at ?? 0,
      idleSince: l.phase === 'idle' ? l.since : 0,
      slimes: recs.filter(x => x.status === 'run').map(x => x.type),
      swarm: recs.filter(x => x.status === 'run' && x.workflow).length,
      cast: p.cast ?? 'rotate',
      turn: t.turns,
      turnStartedAt: l.turnStartedAt,
    }
    const petYard = () => {
      if (p.pet === 'off') {
        stopPets()
        return ''
      }
      const w = Math.max(24, Math.min(width, 64))
      const scene = sceneAt(now)
      advanceYard(yard, scene.mood, w, now)
      const px = drawScene(yard, scene, w)
      const words = l.phase !== 'idle' ? list.find(x => x.kind === 'prompt' && x.turn === t.turns)?.summary : undefined
      const tag = sceneTag(yard, scene)
      const said = words ? `“${oneLine(words, Math.max(8, w - tag.length - 8))}”` : ''
      const bubble =
        tag || said ? (
          <Text wrap="truncate-end">
            {'  '}
            {tag ? <Text color="yellow">{tag}</Text> : ''}
            {tag && said ? <Text dimColor> ▸ </Text> : ''}
            <Text dimColor>{said}</Text>
          </Text>
        ) : (
          ''
        )
      const { Raster, Svg } = $.ui.resolve(e) as any
      if (e.surface === 'terminal') {
        yardWidth = w
        const r = rasterCells(px)
        lastCells = r.cells
        startPets($)
        return (
          <Box flexDirection="column">
            {bubble}
            <Raster key="yard" columns={r.columns} rows={r.rows} cells={r.cells} />
          </Box>
        )
      }
      if (e.surface === 'desktop' || e.surface === 'mobile') {
        return (
          <Box flexDirection="column">
            {bubble}
            <Svg source={svgSource(px, 3)} alt={sceneAlt(scene)} />
          </Box>
        )
      }
      return bubble
    }
    const isBusy = l.phase !== 'idle' || recs.some(x => x.status === 'run')

    // While work runs, a comet runs along the rule under the header.
    const track = () => {
      if (!isBusy) return <Text color={GOOD} dimColor>{'─'.repeat(ruleWidth)}</Text>
      const loop = ruleWidth + 4
      const head = (frame % loop) - 2
      const tail = '░▒▓█'
      const cells = Array.from({ length: ruleWidth }, (_, i) => {
        const d = head - i
        return d >= 0 && d < tail.length ? tail[tail.length - 1 - d] : '─'
      }).join('')
      const lo = Math.max(0, head - tail.length + 1)
      const hi = Math.min(ruleWidth, head + 1)
      return (
        <Text>
          <Text dimColor>{cells.slice(0, lo)}</Text>
          <Text color={ACCENT}>{cells.slice(lo, hi)}</Text>
          <Text dimColor>{cells.slice(hi)}</Text>
        </Text>
      )
    }

    const running = recs.filter(x => x.status === 'run')
    const nowRow = () => {
      if (!isBusy) {
        const last = list.filter(x => x.kind === 'answer').pop()
        return (
          <Text wrap="truncate-end">
            <Text color={GOOD} bold>✓ Ready</Text>
            {last && l.since ? <Text dimColor> · last turn ended {span(now - l.since)} ago</Text> : ''}
          </Text>
        )
      }
      return (
        <Text wrap="truncate-end">
          <Text color={ACCENT} bold>
            {spin} {l.phase === 'idle' ? 'Subagents working' : `Working ${span(now - l.turnStartedAt)}`}
          </Text>
          {l.phase === 'tool' ? (
            <Text dimColor>
              {' '}│ {toolName(l.tool ?? '')}
              {l.label ? ` · ${oneLine(l.label, 40)}` : ''} · {span(now - l.since)}
            </Text>
          ) : l.phase === 'working' ? (
            <Text dimColor> │ thinking · {span(now - l.since)}</Text>
          ) : (
            ''
          )}
          {running.length ? (
            <Text color={AGENT}>
              {' '}│ ◆ {running.length} running
            </Text>
          ) : (
            ''
          )}
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold color={ACCENT}>
            {isBusy ? pulse : '●'} Session {span(now - (t.startedAt || now))}
          </Text>
          <Text dimColor>
            {'  '}
            {plural(t.turns, 'turn', 'turns')} · {plural(t.tools, 'call', 'calls')}
          </Text>
          {recs.length ? <Text color={AGENT}> · {plural(recs.length, 'subagent', 'subagents')}</Text> : ''}
          {t.errors ? <Text color={BAD}> · {t.errors} failed</Text> : ''}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {p.view} view{flags.length ? ` · filter: ${flags.join(', ')}` : ''}
          {quiet ? ' · quiet transcript' : ''}
          {p.isAiOn ? ' · model labels' : ''}
        </Text>
        {t.perTurn.length > 1 ? <Text color={ACCENT} dimColor>{spark(t.perTurn, width - 2)}</Text> : ''}
        {track()}
        {rows.length === 0 ? <Text dimColor>{isFiltered(p) ? 'Nothing matches the filters.' : 'Nothing yet.'}</Text> : ''}
        {rows}
        {petYard()}
        {rule}
        {nowRow()}
        {isKeysShown ? (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {key('o', 'overview', p.view === 'overview')}
              {key('d', 'deep', p.view === 'deep')}
              {key('n', 'narrow', p.view === 'narrow')}
              {key('g', 'end', true)}
              {key('h', 'start', true)}
              {key('c', 'copy', true)}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {key('e', 'errors', p.isErrorsOnly)}
              {key('s', 'slow', p.isSlowOnly)}
              {key('f', `type: ${p.kind}`, p.kind !== 'all')}
              {key('a', 'subagent calls', p.isSubShown)}
              {key('l', 'last 5', p.isRecentOnly)}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {key('p', `pets: ${p.pet}`, p.pet !== 'off')}
              {p.pet === 'slayer' ? key('y', `slayer: ${p.cast === 'rotate' || !p.cast ? 'rotate' : castName(p.cast)}`, true) : ''}
              {key('i', 'portraits', p.isTurnSprites)}
              {key('m', 'labels', p.isAiOn)}
              {key('q', 'quiet', quiet)}
              {key('b', 'band', p.isBandOn)}
              {key('t', 'clock', p.isClockTime)}
              {key('k', 'pin keys', p.isKeysPinned)}
            </Box>
          </Box>
        ) : (
          <Text dimColor>ctrl+x tab for keys · /timeline help</Text>
        )}
      </Box>
    )
  })
}
