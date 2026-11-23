import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'fix-checklist',
  component: 'Pane',
  requestId: 'fix-checklist',
  props: {
    title: 'Checklist',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('Claude adds fixes, marks one done, and the pane shows both', async ($, on) => {
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__fix-checklist__checklist_add',
    title: 'Review fixes',
    items: [{ text: 'Guard empty list', file: 'a.py', line: 3 }, { text: 'Fix off-by-one' }],
  } as never)
  await $.tool.call({ tool: 'mcp__fix-checklist__checklist_mark', id: '1', status: 'done', note: 'added guard' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Guard empty list/ }))?.text).toContain('[x] 1.')
    expect((await ui.find({ type: 'Text', text: /Fix off-by-one/ }))?.text).toContain('[ ] 2.')
    expect((await ui.find({ type: 'Text', text: /1\/2/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('/checklist add, /checklist go and the Fix all button send the list to Claude', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'checklist' } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const added = await $.command.run({ command: 'checklist', args: 'add rename total to subtotal' } as never)
  expect(JSON.stringify(added)).toContain('Added item 1')

  await $.command.run({ command: 'checklist', args: 'go' } as never)
  await clock.advance(100)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('1. [ ] rename total to subtotal')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /rename total/ }))?.text).toContain('(you)')
  await ui.press({ key: 'go' })
  await clock.advance(100)
  expect(sent.length).toBe(2)
  await ui.unmount()
})
