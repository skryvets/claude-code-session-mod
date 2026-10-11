export type SessionLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type SessionSlice = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

export type SessionPull = { branch: string; number: number; state: string }

export type SessionView = {
  tokens: number
  percent: number
  model: string
  effort: string
  folder: string
  branch: string
  changed: number
  ahead: number
  behind: number
  isUnpublished: boolean
  pull: SessionPull | null
  slices: SessionSlice[]
  window: number
  limits: SessionLimit[]
  now: number
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    session: { view: SessionView }
  }
}
