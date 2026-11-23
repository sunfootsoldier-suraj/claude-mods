export type EntryKind = 'prompt' | 'tool' | 'answer'

export type Status = 'run' | 'ok' | 'err'

export type Entry = {
  kind: EntryKind
  at: number
  turn: number
  text: string
  tool?: string
  id?: string
  isSub?: boolean
  // The subagent that made this tool call. Absent on the main loop.
  agentId?: string
  status?: Status
  ms?: number
  isAuto?: boolean
  isRestored?: boolean
  // On a prompt row: a few words that tell what the turn did, or does now.
  summary?: string
  // True when the model wrote the summary. False or absent: the rule-based text.
  isAiSummary?: boolean
}

// One subagent that a turn started.
export type AgentRec = {
  id: string
  // The Agent tool call that started it.
  toolUseId: string
  turn: number
  description: string
  type: string
  startedAt: number
  endedAt?: number
  status: Status
  calls: number
  failed: number
  summary?: string
  isAiSummary?: boolean
  // The run id when a workflow script started the agent. The engine list does not name it.
  workflow?: string
}

export type Live = {
  phase: 'idle' | 'working' | 'tool'
  since: number
  turnStartedAt: number
  tool?: string
  label?: string
  running: number
}

export type View = 'overview' | 'deep' | 'narrow'

export type ToolKind = 'all' | 'edits' | 'commands' | 'reads' | 'agents' | 'web'

export type Prefs = {
  view: View
  isBandOn: boolean
  isSubShown: boolean
  isErrorsOnly: boolean
  isClockTime: boolean
  isRecentOnly: boolean
  isKeysPinned: boolean
  isSlowOnly: boolean
  isAiOn: boolean
  // The yard pets: a swordsman theme, a cat theme, or none.
  pet: 'off' | 'cat' | 'slayer'
  // A portrait on each turn, picked from how the turn went.
  isTurnSprites: boolean
  // The slayer in the yard: one by name, or 'rotate' to change with the work.
  cast: 'rotate' | 'inosuke' | 'tanjiro' | 'zenitsu' | 'nezuko' | 'rengoku' | 'giyu'
  kind: ToolKind
}

export type Totals = { startedAt: number; turns: number; tools: number; errors: number; perTurn: number[] }

declare module 'claude-code' {
  interface PluginState {
    'session-timeline': {
      entries: Entry[]
      agents: AgentRec[]
      // Turns the person opened or closed by hand, by turn number.
      expanded: Record<string, boolean>
      live: Live
      totals: Totals
      isQuiet: boolean
      prefs: Prefs
      sessionId: string
    }
  }
}
