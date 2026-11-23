import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Shown } from '../types'

const PANE = 'image-pane'
const TITLE = 'Images'
const MAX_IMAGES = 100
const images = atom({ plugin: 'image-pane', key: 'images' } as const, [], { shape: 'images-1' })
const index = atom({ plugin: 'image-pane', key: 'index' } as const, 0, { shape: 'index-1' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'images', description: 'Open the image pane' })
    await $.tool.register({
      name: 'show_image',
      description:
        'Show one PNG file in the image pane beside the chat. Give an absolute path. The PNG must be 2 MiB or smaller.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of a PNG file.' },
          title: { type: 'string', description: 'Short title above the image.' },
          caption: { type: 'string', description: 'One or two lines under the image.' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('command.run', { command: 'images' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Image pane opened.' }
  })

  on('tool.run', { tool: 'mcp__image-pane__show_image' }, async ($, e) => {
    // The tool's arguments sit on the event itself, beside `tool` and `tool_use_id`.
    const input = e as unknown as { path?: string; title?: string; caption?: string }
    const path = String(input.path ?? '')
    if (!path.startsWith('/') || !path.toLowerCase().endsWith('.png')) {
      return { result: 'Error: give an absolute path to a .png file.', isError: true }
    }
    const shown: Shown = { path, title: input.title ?? path.split('/').pop() ?? path, caption: input.caption ?? '' }
    const list = await update($, images, all => [...all, shown].slice(-MAX_IMAGES))
    await update($, index, () => list.length - 1)
    await $.ui.open({ id: PANE, title: TITLE })
    return { result: `Shown in the image pane as image ${list.length} of ${list.length}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Image } = $.ui.resolve(e) as any
    const list = await read($, images)
    if (list.length === 0) return <Text dimColor>No images yet. Claude sends them with show_image.</Text>
    const at = Math.min(Math.max(0, await read($, index)), list.length - 1)
    const item = list[at]
    const cols = Math.max(10, Math.min(255, (e.viewport?.columns ?? 80) - 2))
    const rows = Math.max(5, Math.min(255, (e.viewport?.rows ?? 30) - 7))
    const move = (step: number) => async () => {
      await update($, index, i => Math.min(Math.max(0, i + step), list.length - 1))
    }
    let picture
    if (!Image) {
      picture = <Text dimColor>This surface cannot draw images. File: {item.path}</Text>
    } else {
      try {
        const bytes = (await $.fs.read(item.path, { as: 'bytes' })) as { base64: string }
        picture = <Image key="view" source={{ png: bytes.base64 }} columns={cols} rows={rows} alt={item.title} />
      } catch (err) {
        picture = <Text color="red">Cannot read {item.path}: {String(err)}</Text>
      }
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="prev" hotkey="p" onPress={move(-1)}>Prev</Button>
          <Button key="next" hotkey="n" onPress={move(1)}>Next</Button>
          <Text dimColor>{at + 1} / {list.length}</Text>
        </Box>
        <Text bold>{item.title}</Text>
        {picture}
        {item.caption ? <Text dimColor>{item.caption}</Text> : null}
      </Box>
    )
  })
}
