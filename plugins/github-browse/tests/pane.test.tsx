import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'github-browse',
  component: 'Pane',
  requestId: 'github-browse',
  props: {
    title: 'GitHub',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const FILE = [
  'def handle(req):',
  '    data = parse(req)',
  '    return process(data)',
  '',
  'def parse(req):',
  '    return req.body',
  '',
  'def process(data):',
  '    return save(data)',
].join('\n')

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('a trace step draws, and a call jumps to its definition', async ($, on) => {
  on('command.register', () => ({ value: { command: 'github-browse' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__github-browse__github_show' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ok(JSON.stringify({ type: 'file', encoding: 'base64', content: btoa(FILE) })))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.tool.call({
    tool: 'mcp__github-browse__github_show',
    repo: 'acme/app',
    path: 'src/api.py',
    start_line: 2,
    end_line: 3,
    title: 'Request enters handler',
    new_trace: true,
  })
  expect(JSON.stringify(out)).toContain('lines 2-3')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Request enters handler/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /api.py/ }))?.text).toContain('api.py')
    expect(await ui.find({ type: 'Button', key: 'call-parse' })).toBeDefined()
    // The code itself must draw: a Code element on the terminal, an Svg elsewhere.
    const drawn = await ui.find({ type: surface === 'terminal' ? 'Code' : 'Svg' })
    expect(drawn).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'call-parse' })
  await ui.unmount()

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /L5/ }))?.text).toContain('L5')
  expect((await after.find({ type: 'Text', text: /L5/ }))?.text).toContain('L5')
  await after.unmount()
})

test('the empty pane explains itself', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Ask Claude/ }))?.text).toMatch(/trace/)
  await ui.unmount()
})
