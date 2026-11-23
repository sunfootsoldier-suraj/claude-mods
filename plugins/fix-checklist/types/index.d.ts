export type Status = 'todo' | 'doing' | 'done' | 'skipped'

export type Item = {
  id: string
  text: string
  status: Status
  file?: string
  line?: number
  note?: string
  by: 'you' | 'claude'
}

declare module 'claude-code' {
  interface PluginState {
    'fix-checklist': {
      items: Shaped<Item[]>
      title: Shaped<string>
    }
  }
}
