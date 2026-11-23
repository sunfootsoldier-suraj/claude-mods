import { expect, mock, test } from 'claude-code/testing'

import { newYard } from '../hooks/pets'
import { battleSlots, castAt, drawScene, portraitFor, sceneAlt } from '../hooks/slayer'

const PANE = { plugin: 'session-timeline', component: 'Pane', requestId: 'timeline', props: { title: 'Timeline' } } as const
const SURFACES = ['terminal', 'desktop'] as const
const NO_MARKUP = /[<>]|\[[^\]]*\]/

type World = {
  id?: () => string
  messages?: unknown[]
  store?: Record<string, unknown>
  label?: string
  agents?: unknown[]
  toolError?: boolean
  model?: () => Promise<unknown>
}

// Everything beneath the plugin that the timeline calls, answered from memory.
function world(on: any, w: World = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, w.store ?? {})
  on('session.id', async () => ({ value: (w.id ?? (() => 'S'))() }) as never)
  on('session.messages', async () => ({ value: w.messages ?? [] }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: {} } }) as never)
  on('agent.list', async () => ({ value: w.agents ?? [] }) as never)
  on('model.complete', async () =>
    w.model ? ((await w.model()) as never) : ({
      value: w.label
        ? { isAnswered: true, text: w.label, usage: { input_tokens: 1, output_tokens: 1 } }
        : { isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0 } },
    }) as never,
  )
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.copy', async () => ({ value: { isCopied: true } }) as never)
  on('ui.scroll', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: unknown, e: any) => ({ text: e.text }) as never)
  on('tool.call', async () => (w.toolError ? { result: 'boom', isError: true } : { result: 'ok' }) as never)
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer ?? '' }) as never)
  on('agent.spawn', async () => ({ model: 'haiku', agentId: 'ag1' }) as never)
  return clock
}

const done = (text = '') => ({ answer: text, durationMs: 4000, isAborted: false, turnId: 'x', reason: 'answer' }) as never

// Let the labels the hooks asked for in the background arrive.
async function settle(clock: any) {
  for (let i = 0; i < 5; i++) await clock.advance?.(10)
}

test('a turn adds a prompt row, a tool row and an end row', async ($, on) => {
  const clock = world(on)
  await $.prompt.submit({ text: 'Run the tests please', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'ls', description: 'List files' } as never)
  await $.turn.complete(done('done'))
  await settle(clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 60, rows: 30 } } as never)
    expect(await ui.find({ text: /Run the tests please/ })).toBeDefined()
    expect(await ui.find({ text: /Ran 1 command/ })).toBeDefined()
    expect(await ui.find({ text: /1 turn · 1 call/ })).toBeDefined()
  }
})

test('a failed tool call counts as failed', async ($, on) => {
  world(on, { toolError: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'false' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ text: /1 failed/ })).toBeDefined()
})

test('quiet mode hides a tool row, and the command shows it again', async ($, on) => {
  world(on)
  on('ui.render', { component: 'ToolUse' }, async () => ({ type: 'Text', props: {}, children: ['row'] }) as never)
  const row = { plugin: 'session-timeline', component: 'ToolUse', surface: 'terminal', props: { tool_use_id: 'a', tool: 'Bash' } } as const
  const hidden = await $.ui.mount(row as never)
  expect(await hidden.find({ text: /row/ })).toBeUndefined()
  await $.command.run({ command: 'timeline-quiet', args: '' } as never)
  const shown = await $.ui.mount(row as never)
  expect(await shown.find({ text: /row/ })).toBeDefined()
})

test('rows show plain words, with no tags and no bracket markers', async ($, on) => {
  world(on, { id: () => 'S1' })
  const prompts = [
    'Check the run <system-reminder>secret engine text</system-reminder>',
    '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>b1</task-id><summary>Monitor event: "counts ready"</summary></task-notification>',
    '[Request interrupted by user for tool use]',
    '<command-name>/export</command-name><command-message>export</command-message><command-args></command-args>',
  ]
  for (const text of prompts) {
    await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
    await $.turn.complete(done())
  }
  await $.command.run({ command: 'timeline', args: 'deep' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 80, rows: 40 } } as never)
    expect(await ui.find({ text: /Check the run/ })).toBeDefined()
    expect(await ui.find({ text: /secret engine text/ })).toBeUndefined()
    expect(await ui.find({ text: /counts ready/ })).toBeDefined()
    expect(await ui.find({ text: /You stopped Claude/ })).toBeDefined()
    expect(await ui.find({ text: /Ran \/export/ })).toBeDefined()
    expect(await ui.find({ text: NO_MARKUP })).toBeUndefined()
  }
})

test('a resumed session shows its earlier turns from the transcript', async ($, on) => {
  const transcript = [
    { role: 'user', text: 'Copy the mods to scalar01', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'u1', tool: 'Bash', input: { command: 'rsync', description: 'Copy the mods' }, text: 'ok' },
        { tool_use_id: 'u2', tool: 'Bash', input: { command: 'false' }, text: 'boom', isError: true },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'ok' }] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  ]
  world(on, { id: () => 'RESUMED', messages: transcript })
  await $.prompt.submit({ text: 'And now the next step', origin: { kind: 'composer' } } as never)
  await $.command.run({ command: 'timeline', args: 'deep' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 80, rows: 40 } } as never)
    expect(await ui.find({ text: /Copy the mods to scalar01/ })).toBeDefined()
    expect(await ui.find({ text: /Copy the mods$|Copy the mods\b/ })).toBeDefined()
    expect(await ui.find({ text: /And now the next step/ })).toBeDefined()
    expect(await ui.find({ text: /2 turns/ })).toBeDefined()
    expect(await ui.find({ text: /1 failed/ })).toBeDefined()
  }
})

test('a new session id swaps the rows for that session', async ($, on) => {
  const saved = {
    entries: [{ kind: 'prompt', at: 1000, turn: 1, text: 'Old session work' }],
    totals: { startedAt: 0, turns: 1, tools: 0, errors: 0, perTurn: [0] },
  }
  let id = 'A'
  world(on, { id: () => id, store: { 'history:B': saved } })
  await $.prompt.submit({ text: 'Work in session A', origin: { kind: 'composer' } } as never)
  id = 'B'
  await $.prompt.submit({ text: 'Back in session B', origin: { kind: 'composer' } } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 80, rows: 40 } } as never)
    expect(await ui.find({ text: /Old session work/ })).toBeDefined()
    expect(await ui.find({ text: /Back in session B/ })).toBeDefined()
    expect(await ui.find({ text: /Work in session A/ })).toBeUndefined()
  }
})

test('a finished turn shows the few words the model wrote, and keeps its steps', async ($, on) => {
  const clock = world(on, { id: () => 'S2', label: '"Running the unit tests."' })
  await $.prompt.submit({ text: 'Please check everything', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest', description: 'Run pytest' } as never)
  await $.turn.complete(done('All pass'))
  await settle(clock)
  await $.command.run({ command: 'timeline', args: 'deep' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 80, rows: 40 } } as never)
    expect(await ui.find({ text: /^Running the unit tests$/ })).toBeDefined()
    expect(await ui.find({ text: /Run pytest/ })).toBeDefined()
  }
})

test('with no model answer the turn keeps the rule-based sentence', async ($, on) => {
  const clock = world(on, { id: () => 'S3' })
  await $.prompt.submit({ text: 'Look at a file', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/a/b/notes.md' } as never)
  await $.turn.complete(done())
  await settle(clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 40 } } as never)
  expect(await ui.find({ text: /Looked at 1 file/ })).toBeDefined()
})

test('a subagent gets a lane with its task, its label and its calls', async ($, on) => {
  const clock = world(on, {
    id: () => 'S4',
    label: 'Searching the mod types',
    agents: [{ id: 'ag1', description: 'Find scroll props', type: 'Explore', status: 'running' }],
  })
  await $.prompt.submit({ text: 'Find the scroll API', origin: { kind: 'composer' } } as never)
  await $.agent.spawn({
    tool_use_id: 'A1',
    prompt: 'Find it',
    description: 'Find scroll props',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
  } as never)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'A1', description: 'Find scroll props', prompt: 'Find it' } as never)
  await $.tool.call({ tool: 'Grep', tool_use_id: 'g1', pattern: 'SiteScroll', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'g2', file_path: '/x/claude-code.d.ts', agentId: 'ag1' } as never)
  await settle(clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 90, rows: 40 } } as never)
    expect(await ui.find({ text: /Explore/ })).toBeDefined()
    expect(await ui.find({ text: /Find scroll props/ })).toBeDefined()
    expect(await ui.find({ text: /Searching the mod types/ })).toBeDefined()
    expect(await ui.find({ text: /claude-code\.d\.ts/ })).toBeDefined()
  }
})

test('the pane keeps every turn, with no row cap', async ($, on) => {
  world(on, { id: () => 'S5' })
  for (let i = 1; i <= 40; i++) {
    await $.prompt.submit({ text: `Prompt number ${i}`, origin: { kind: 'composer' } } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: `t${i}`, command: 'ls', description: `Step ${i}` } as never)
    await $.turn.complete(done())
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 20 } } as never)
  expect(await ui.find({ text: /Prompt number 1$/ })).toBeDefined()
  expect(await ui.find({ text: /Prompt number 40/ })).toBeDefined()
  expect(await ui.find({ text: /earlier rows/ })).toBeUndefined()
})

test('a stored setting from an older version keeps the model labels on', async ($, on) => {
  const old = { prefs: { view: 'deep', isBandOn: true, kind: 'all' }, isQuiet: true }
  const clock = world(on, { id: () => 'S6', label: 'Checking the parser', store: { 'prefs-v4': old } })
  await $.session.start({ source: 'startup' } as never).catch(() => undefined)
  await $.prompt.submit({ text: 'Check the parser', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'p1', file_path: '/a/parser.py' } as never)
  await $.turn.complete(done('Looks fine'))
  await settle(clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 40 } } as never)
  expect(await ui.find({ text: /^Checking the parser$/ })).toBeDefined()
})

test('the final label wins over a label that was still in flight', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(r => (release = r))
  let asks = 0
  const clock = world(on, {
    id: () => 'S7',
    model: async () => {
      asks += 1
      const text = asks === 1 ? 'Running pytest' : 'Fixed the parser bug'
      if (asks === 1) await held
      return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
    },
  })
  await $.prompt.submit({ text: 'Fix the parser', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'f1', file_path: '/a/parser.py' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'f2', command: 'pytest', description: 'Run pytest' } as never)
  await $.turn.complete(done('Fixed'))
  release()
  await settle(clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 40 } } as never)
  expect(await ui.find({ text: /^Fixed the parser bug$/ })).toBeDefined()
  expect(await ui.find({ text: /^Running pytest$/ })).toBeUndefined()
})

test('the pet yard draws pixels on the terminal and an SVG on desktop', async ($, on) => {
  world(on, { id: () => 'S8', agents: [{ id: 'ag1', description: 'Look', type: 'Explore', status: 'running' }] })
  on('ui.blit', async () => ({ value: {} }) as never)
  await $.prompt.submit({ text: 'Start some work', origin: { kind: 'composer' } } as never)
  await $.agent.spawn({
    tool_use_id: 'A9',
    prompt: 'Look',
    description: 'Look',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
  } as never)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 40 } } as never)
  expect(await term.find({ type: 'Raster', key: 'yard' })).toBeDefined()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 40 } } as never)
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await $.command.run({ command: 'timeline', args: 'pets off' } as never)
  expect(await term.find({ type: 'Raster', key: 'yard' })).toBeUndefined()
})

test('Inosuke is the default slayer, and the cast rotates while work runs', () => {
  const at = { pin: 'rotate' as const, isBusy: false, turn: 3, turnStartedAt: 0, now: 0 }
  expect(castAt(at)).toBe('inosuke')
  expect(castAt({ ...at, isBusy: true, turn: 1, turnStartedAt: 1000, now: 2000 })).toBe('inosuke')
  expect(castAt({ ...at, isBusy: true, turn: 2, turnStartedAt: 1000, now: 2000 })).toBe('tanjiro')
  expect(castAt({ ...at, isBusy: true, turn: 2, turnStartedAt: 1000, now: 62_000 })).toBe('nezuko')
  expect(castAt({ ...at, pin: 'giyu', isBusy: true })).toBe('giyu')
  // The slayer yard is 6 terminal rows: 12 pixels.
  const px = drawScene(newYard(), { theme: 'slayer', mood: 'run', slimes: ['Explore'], who: 'zenitsu' }, 40)
  expect(px.h).toBe(12)
  expect(px.px.some(v => v === 0xffd166)).toBe(true)
})

test('the portrait rules pick good guys by rank and bad guys by failures', () => {
  const base = { isRunning: false, isAuto: false, isStopped: false, isErrorEnd: false, calls: 2, failed: 0, ms: 10_000 }
  expect(portraitFor(base)).toBe('recruit')
  expect(portraitFor({ ...base, ms: 90_000 })).toBe('swordsman')
  expect(portraitFor({ ...base, calls: 40 })).toBe('pillar')
  expect(portraitFor({ ...base, failed: 1 })).toBe('lesser')
  expect(portraitFor({ ...base, calls: 10, failed: 3 })).toBe('demon')
  expect(portraitFor({ ...base, calls: 50, failed: 6 })).toBe('upper')
  expect(portraitFor({ ...base, isErrorEnd: true })).toBe('upper')
  expect(portraitFor({ ...base, calls: 40, failed: 1 })).toBe('pillar')
  expect(portraitFor({ ...base, isRunning: true })).toBe('fighter')
  expect(portraitFor({ ...base, isStopped: true })).toBe('resting')
  expect(portraitFor({ ...base, isAuto: true })).toBe('crow')
})

test('each turn gets a portrait on the terminal and on desktop, and the key turns them off', async ($, on) => {
  world(on, { id: () => 'S9', toolError: true })
  on('ui.blit', async () => ({ value: {} }) as never)
  await $.prompt.submit({ text: 'Break something', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'x1', command: 'false' } as never)
  await $.turn.complete(done('It failed'))
  const term = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 90, rows: 40 } } as never)
  expect(await term.find({ type: 'Raster', key: 'face-1-0' })).toBeDefined()
  expect(await term.find({ text: /Break something/ })).toBeDefined()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 90, rows: 40 } } as never)
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await $.command.run({ command: 'timeline', args: 'sprites' } as never)
  expect(await term.find({ type: 'Raster', key: 'face-1-0' })).toBeUndefined()
})

test('a workflow run draws slayers that fight demons, and a flock of crows', () => {
  const scene = { theme: 'slayer' as const, mood: 'walk' as const, slimes: ['workflow', 'workflow', 'workflow'], who: 'inosuke' as const }
  const calm = drawScene(newYard(), scene, 64)
  const battle = drawScene(newYard(), { ...scene, swarm: 3 }, 64)
  // The demon colours show only in the battle: Rui's red lines and Akaza's pink hair.
  expect(calm.px.some(v => v === 0xf78fb3)).toBe(false)
  expect(battle.px.some(v => v === 0xf78fb3)).toBe(true)
  expect(battle.px.filter(v => v !== -1).length).toBeGreaterThan(calm.px.filter(v => v !== -1).length)
  // The pairs keep clear of the slayer head and stay inside the yard.
  for (const sx of battleSlots(20, 64, 9)) {
    expect(sx + 16 <= 64).toBe(true)
    expect(sx + 16 <= 19 || sx >= 33).toBe(true)
  }
  expect(battleSlots(4, 64, 1).length).toBe(1)
  expect(sceneAlt({ ...scene, swarm: 3 })).toMatch(/slayers fight demons/)
})

test('a workflow agent stays in the yard although the engine list does not name it', async ($, on) => {
  const clock = world(on, { id: () => 'S9', agents: [] })
  on('ui.blit', async () => ({ value: {} }) as never)
  await $.prompt.submit({ text: 'Run the review workflow', origin: { kind: 'composer' } } as never)
  await $.agent.spawn({
    tool_use_id: 'W1',
    prompt: 'Review it',
    description: 'review:bugs',
    workflow: { runId: 'wf_abc123', index: 1 },
    provider: { plugin: 'engine', tier: 'core' },
  } as never)
  await $.tool.call({ tool: 'Grep', tool_use_id: 'w2', pattern: 'x', agentId: 'ag1' } as never)
  await clock.advance?.(5000)
  await settle(clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 90, rows: 40 } } as never)
  expect(await ui.find({ text: /workflow battle: 1 agent/ })).toBeDefined()
  await $.turn.complete({ ...(done() as object), agentId: 'ag1' } as never)
  await settle(clock)
  expect(await ui.find({ text: /workflow battle/ })).toBeUndefined()
})
