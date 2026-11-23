import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Status } from '../types'

const PANE = 'fix-checklist'
const TITLE = 'Checklist'
const SET_TOOL = 'mcp__fix-checklist__checklist_add'
const MARK_TOOL = 'mcp__fix-checklist__checklist_mark'

const items = atom({ plugin: 'fix-checklist', key: 'items' } as const, [], { shape: 'items-1' })
const title = atom({ plugin: 'fix-checklist', key: 'title' } as const, 'Fixes to make', { shape: 'title-1' })

const GLYPH: Record<Status, string> = { todo: '[ ]', doing: '[~]', done: '[x]', skipped: '[-]' }
const COLOR: Record<Status, string> = { todo: 'text', doing: 'warning', done: 'success', skipped: 'inactive' }

const ADD_DESCRIPTION = [
  'Add items to the checklist pane beside the chat. The pane shows the fixes still to make and ticks each one as you finish it.',
  'Use it when the user gives you a list of changes, or when a review or debug pass finds several fixes: add every fix first, then work through them in order.',
  'Each item is one fix, written as an imperative of 12 words or fewer. Give file and line when you know where the fix goes.',
  'Set replace to true to clear the list first. The result lists every item with its id.',
].join(' ')

const MARK_DESCRIPTION = [
  'Set the status of one checklist item in the pane.',
  'Mark an item "doing" before you start it and "done" when the change is made and checked. Mark "skipped" with a note when you do not make the fix.',
  'note is one short line: what you changed, or why you skipped it.',
].join(' ')

const GO_PROMPT = [
  'Work through every open item on my checklist, in order, in one go.',
  'For each item: mark it doing, make the fix, check it (run the tests if there are any), then mark it done with a one-line note.',
  'If an item is unclear or unsafe, mark it skipped with the reason and continue. Summarise at the end.',
].join(' ')

type AddInput = {
  title?: string
  replace?: boolean
  items?: { text: string; file?: string; line?: number }[]
}

type MarkInput = { id: string; status: Status; note?: string }

let counter = 0

const nextId = (list: Item[]) => {
  const top = list.reduce((max, one) => Math.max(max, Number(one.id) || 0), counter)
  counter = top + 1

  return String(counter)
}

const listing = (list: Item[]) =>
  list.length === 0
    ? 'The checklist is empty.'
    : list
        .map(one => `${one.id}. ${GLYPH[one.status]} ${one.text}${one.file ? ` (${one.file}${one.line ? `:${one.line}` : ''})` : ''}${one.note ? ` -- ${one.note}` : ''}`)
        .join('\n')

const addItems = async ($: EngineInterface, input: AddInput, by: Item['by']) => {
  if (input.title) await update($, title, () => input.title as string)
  let after: Item[] = []
  await update($, items, list => {
    const base = input.replace ? [] : list
    if (input.replace) counter = 0
    const added = (input.items ?? [])
      .filter(one => one.text?.trim())
      .map(one => ({ id: '', text: one.text.trim(), file: one.file, line: one.line, status: 'todo' as const, by }))
    const out = [...base]
    for (const one of added) out.push({ ...one, id: nextId(out) })
    after = out

    return out
  })

  return after
}

const mark = async ($: EngineInterface, input: MarkInput) => {
  let found = false
  let after: Item[] = []
  await update($, items, list => {
    after = list.map(one => {
      if (one.id !== String(input.id)) return one
      found = true

      return { ...one, status: input.status, note: input.note ?? one.note }
    })

    return after
  })

  return { found, after }
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

// A slash command holds the turn while its hook runs, so a submit from inside
// it would wait on itself. Send the prompt from a timer once the hook returns.
const sendGo = ($: EngineInterface) => {
  $.clock.after(50, async () => {
    const now = await read($, items)
    await $.prompt.submit({ text: `${GO_PROMPT}\n\nChecklist:\n${listing(now)}`, asUser: true })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Checklist pane. /checklist add <fix>, /checklist go, /checklist clear',
    })
    const started = await next(e)
    await $.tool.register({
      name: 'checklist_add',
      description: ADD_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Heading of the checklist, 2-6 words' },
          replace: { type: 'boolean', description: 'Clear the list before adding' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                file: { type: 'string' },
                line: { type: 'integer', minimum: 1 },
              },
              required: ['text'],
            },
          },
        },
        required: ['items'],
      },
    })
    await $.tool.register({
      name: 'checklist_mark',
      description: MARK_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id from the checklist' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'skipped'] },
          note: { type: 'string', description: 'One short line' },
        },
        required: ['id', 'status'],
      },
    })

    return started
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const [verb, ...rest] = args.split(/\s+/)
    const text = rest.join(' ').trim()

    if (verb === 'add' && text) {
      const list = await addItems($, { items: [{ text }] }, 'you')
      await open($)

      return { text: `Added item ${list[list.length - 1]?.id}: ${text}` }
    }
    if (verb === 'clear') {
      await update($, items, () => [])
      counter = 0

      return { text: 'Checklist cleared.' }
    }
    if (verb === 'go') {
      await open($)
      sendGo($)

      return { text: 'Asked Claude to work through the checklist.' }
    }
    await open($)

    return { text: 'Checklist pane opened. Use /checklist add <fix>, then /checklist go.' }
  })

  on('tool.call', { tool: SET_TOOL }, async ($, e) => {
    const list = await addItems($, e as unknown as AddInput, 'claude')
    void open($)

    return { result: listing(list) }
  }).catch(() => ({ deny: 'The checklist pane failed to add the items.' }))

  on('tool.call', { tool: MARK_TOOL }, async ($, e) => {
    const input = e as unknown as MarkInput
    const { found, after } = await mark($, input)
    if (!found) return { deny: `No checklist item has id ${input.id}.\n${listing(after)}` }
    const open_ = after.filter(one => one.status === 'todo' || one.status === 'doing').length
    if (input.status === 'done') void $.ui.status(`checklist: ${after.length - open_}/${after.length}`)

    return { result: `Item ${input.id} is ${input.status}. ${open_} item(s) still open.` }
  }).catch(() => ({ deny: 'The checklist pane failed to mark the item.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const heading = await read($, title)
    const done = list.filter(one => one.status === 'done' || one.status === 'skipped').length
    const width = 20
    const filled = list.length ? Math.round((done / list.length) * width) : 0
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
    const hasOpen = list.some(one => one.status === 'todo' || one.status === 'doing')

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">{heading}</Text>
          <Text dimColor>
            {done}/{list.length} done
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Text weight="semibold">{heading}</Text>
          <Text dimColor>
            {bar} {done}/{list.length}
          </Text>
        </Box>
        {list.length === 0 && (
          <Text dimColor>
            No items yet. Type /checklist add &lt;fix&gt; for each change, then /checklist go. Or ask Claude to put its
            findings on the checklist.
          </Text>
        )}
        <Box flexDirection="column">
          {list.map(one => (
            <Box flexDirection="column">
              <Text
                color={COLOR[one.status]}
                strikethrough={one.status === 'skipped'}
                dimColor={one.status === 'done'}
              >
                {GLYPH[one.status]} {one.id}. {one.text}
                {one.by === 'you' ? ' (you)' : ''}
              </Text>
              {(one.file || one.note) && (
                <Text dimColor wrap="truncate-end">
                  {'    '}
                  {one.file ? `${one.file}${one.line ? `:${one.line}` : ''}` : ''}
                  {one.file && one.note ? ' · ' : ''}
                  {one.note ?? ''}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          {hasOpen && (
            <Button
              key="go"
              variant="primary"
              onPress={() => sendGo($)}
            >
              Fix all open items
            </Button>
          )}
          {done > 0 && (
            <Button
              key="clear"
              dimColor
              onPress={() => {
                void update($, items, now => now.filter(one => one.status !== 'done' && one.status !== 'skipped'))
              }}
            >
              Clear finished
            </Button>
          )}
        </Box>
      </Box>
    )
  })
}
