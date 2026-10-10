export type SessionLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type SessionView = {
  tokens: number
  percent: number
  model: string
  effort: string
  folder: string
  branch: string
  limits: SessionLimit[]
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    session: { view: SessionView }
  }
}
