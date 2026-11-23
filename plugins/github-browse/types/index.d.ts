export type Excerpt = { start: number; text: string }

export type Entry = { name: string; isDir: boolean }

export type SymbolRef = { name: string; line: number; isClass: boolean }

export type Stop = {
  id: number
  /** True when the person navigated here by a click; false for a step Claude placed. */
  isUser: boolean
  repo?: string
  ref?: string
  path: string
  title?: string
  startLine?: number
  endLine?: number
  context: number
  note?: string
  url?: string
  totalLines?: number
  before?: Excerpt
  focus?: Excerpt
  after?: Excerpt
  entries?: Entry[]
  symbols?: SymbolRef[]
  calls?: string[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'github-browse': {
      stops: Shaped<Stop[]>
      cursor: Shaped<number>
      busy: Shaped<string>
      outline: Shaped<boolean>
    }
  }
}
