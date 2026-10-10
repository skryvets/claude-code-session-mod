import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionLimit, SessionSlice, SessionView } from '../types'

const HOUR = 3600000
const SPAN: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }
const NAME: Record<string, string> = { five_hour: 'Session', seven_day: 'Weekly' }
const BAR = 24
const ORDER = { used: 0, free: 1, buffer: 2 }
const GLYPH = { used: '█', free: '░', buffer: '▒' }
const LABEL: Record<string, string> = {
  'System prompt': 'system',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'MCP server instructions': 'mcp info',
  'Memory files': 'memory',
  'Custom agents': 'agents',
  Messages: 'msgs',
  'Autocompact buffer': 'buffer',
}
// Palette follows context-bar by Hamza Zafar (github.com/hamzafer/claude-code-mods): /context's theme gives several rows the same grey
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#c0caf5']
const EMPTY: SessionView = {
  tokens: 0,
  percent: 0,
  model: '',
  effort: '',
  folder: '',
  branch: '',
  slices: [],
  window: 0,
  limits: [],
  now: 0,
}
const view = atom({ plugin: 'session', key: 'view' } as const, EMPTY)

const short = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1e6).toFixed(1)}M`

const left = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  const hours = Math.floor(minutes / 60)

  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours > 0
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`
}

const heat = (percent: number) =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

const cells = (percent: number) =>
  percent > 0 ? Math.min(BAR, Math.max(1, Math.round((percent / 100) * BAR))) : 0

const stack = (slices: SessionSlice[], window: number) => {
  const sizes = slices.map(slice =>
    slice.kind === 'free'
      ? 0
      : Math.max(slice.kind === 'used' ? 1 : 0, Math.round((slice.tokens / window) * BAR)),
  )
  const free = slices.findIndex(slice => slice.kind === 'free')
  let spare = BAR - sizes.reduce((sum, size) => sum + size, 0)

  if (spare > 0 && free >= 0) {
    sizes[free] = spare
    spare = 0
  }

  while (spare !== 0) {
    sizes[sizes.indexOf(Math.max(...sizes))]! += Math.sign(spare)
    spare -= Math.sign(spare)
  }

  let next = 0

  return slices.map((slice, i) => ({
    ...slice,
    label: LABEL[slice.name] ?? slice.name.toLowerCase(),
    size: sizes[i]!,
    color:
      slice.kind !== 'used'
        ? 'inactive'
        : slice.name === 'Messages'
          ? 'claude'
          : PALETTE[next++ % PALETTE.length]!,
  }))
}

const untilReset = (limit: SessionLimit, now: number) =>
  limit.resetsAt ? Date.parse(limit.resetsAt) - now : 0

// Pace rules follow CodexBar's UsagePace.swift and UsagePaceText.swift (github.com/steipete/CodexBar)
const pace = (limit: SessionLimit, now: number) => {
  const span = SPAN[limit.kind]
  const remaining = untilReset(limit, now)

  if (!span || remaining <= 0 || remaining > span) return null

  const elapsed = span - remaining
  const expected = (elapsed / span) * 100
  const actual = Math.min(100, Math.max(0, limit.percentUsed))

  if (actual >= 100) return { verdict: 'limit reached', outlook: '', color: 'error' }
  if (expected < 3) return null

  const delta = actual - expected
  const runsOutIn = actual > 0 ? ((100 - actual) / actual) * elapsed : Infinity

  return {
    verdict:
      Math.abs(delta) <= 2
        ? 'on pace'
        : `${Math.round(Math.abs(delta))}% in ${delta > 0 ? 'deficit' : 'reserve'}`,
    outlook: runsOutIn >= remaining ? 'lasts until reset' : `runs out in ${left(runsOutIn)}`,
    color: delta > 12 ? 'error' : delta > 2 ? 'warning' : 'success',
  }
}

const sync = async ($: EngineInterface, effort: string) => {
  const [cwd, home, model, usage, now, git] = await Promise.all([
    $.session.cwd(),
    $.env.get('HOME'),
    $.session.model(),
    $.session.usage({ breakdown: 'summary' }),
    $.clock.now(),
    $.process.run(['git', 'branch', '--show-current']).catch(() => null),
  ])
  await update($, view, () => ({
    tokens: usage.context.tokens ?? usage.context.breakdown?.totalTokens ?? 0,
    percent: usage.context.percent ?? usage.context.breakdown?.percentage ?? 0,
    model,
    effort,
    folder: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
    branch: git?.exitCode === 0 ? git.stdout.trim() : '',
    slices: (usage.context.breakdown?.categories ?? [])
      .flatMap(({ name, tokens, kind }) =>
        kind === 'deferred' || tokens <= 0 ? [] : [{ name, tokens, kind }],
      )
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]),
    window: usage.context.breakdown?.rawMaxTokens ?? 0,
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) =>
      resetsAt ? { kind, percentUsed, resetsAt } : { kind, percentUsed },
    ),
    now,
  }))
}

export const register: Register = on => {
  let effort = ''

  on('session.start', async ($, e, next) => {
    await sync($, effort)
    $.clock.every(60000, () => sync($, effort))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await sync($, effort)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      await sync($, effort).catch(() => {})
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const asked = String(e.effort ?? '')

    if (e.agentId === undefined && asked !== effort) {
      effort = asked
      await sync($, effort)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await sync($, effort)
    }

    return next(e)
  })

  // Drawn above the prompt because the engine drops PromptHint while it shows a notice of its own ("paste again to expand")
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const now = await read($, view)

    if (e.props.hasSurvey || now.model === '') {
      return rest
    }

    const { Box, Text } = $.ui.resolve(e)
    const dot = <Text dimColor> · </Text>
    const row = (label: string, percent: number, color: string) => [
      <Text bold>{`${label}:`.padEnd(9)}</Text>,
      <Text color={color}>{'█'.repeat(cells(percent))}</Text>,
      <Text color="inactive">{'░'.repeat(BAR - cells(percent))}</Text>,
    ]

    const parts = now.window > 0 ? stack(now.slices, now.window) : []
    const lines = 2 + now.limits.filter(limit => NAME[limit.kind]).length
    const space = e.props.maxRows >= lines * 2 ? 1 : 0

    return (
      <Box flexDirection="column" gap={space} paddingTop={space} paddingLeft={2}>
        <Text wrap="truncate-end">
          <Text>{now.model}</Text>
          {now.effort !== '' && dot}
          {now.effort !== '' && <Text color="claude">{now.effort}</Text>}
          {dot}
          <Text dimColor>{now.folder}</Text>
          {now.branch !== '' && <Text color="suggestion">{` (${now.branch})`}</Text>}
        </Text>
        <Text wrap="truncate-end">
          {parts.length === 0
            ? row('Context', now.percent, heat(now.percent))
            : [
                <Text bold>{'Context: '}</Text>,
                ...parts.map(part => (
                  <Text color={part.color}>{GLYPH[part.kind].repeat(part.size)}</Text>
                )),
              ]}
          <Text bold color={heat(now.percent)}>{` ${short(now.tokens)}`}</Text>
          <Text>{` (${now.percent}%)`}</Text>
          {/* TODO: confirm the legend is wanted - it is the only added text and is the first thing cut on a narrow terminal */}
          {parts
            .filter(part => part.kind !== 'free')
            .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.tokens - a.tokens)
            .map((part, i) => (
              <Text>
                {i === 0 ? dot : '  '}
                <Text color={part.color}>{part.kind === 'used' ? '■' : GLYPH[part.kind]}</Text>
                <Text dimColor>{` ${part.label}`}</Text>
              </Text>
            ))}
        </Text>
        {now.limits.flatMap(limit => {
          const name = NAME[limit.kind]

          if (!name) return []

          const at = pace(limit, now.now)
          const reset = untilReset(limit, now.now)

          return [
            <Text wrap="truncate-end">
              {row(name, limit.percentUsed, at?.color ?? heat(limit.percentUsed))}
              <Text>{` ${Math.round(limit.percentUsed)}% used`}</Text>
              {at && dot}
              {at && <Text color={at.color}>{at.verdict}</Text>}
              {at && at.outlook !== '' && dot}
              {at && at.outlook !== '' && <Text color={at.color}>{at.outlook}</Text>}
              {reset > 0 && dot}
              {reset > 0 && <Text dimColor>{`resets in ${left(reset)}`}</Text>}
            </Text>,
          ]
        })}
        {rest}
      </Box>
    )
  })
}
