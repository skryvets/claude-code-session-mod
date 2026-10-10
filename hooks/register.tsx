import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionLimit, SessionView } from '../types'

const HOUR = 3600000
const SPAN: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }
const NAME: Record<string, string> = { five_hour: 'Session', seven_day: 'Weekly' }
const BAR = 8
const EMPTY: SessionView = {
  tokens: 0,
  percent: 0,
  model: '',
  effort: '',
  folder: '',
  branch: '',
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

const cells = (percent: number) => Math.min(BAR, Math.max(0, Math.round((percent / 100) * BAR)))

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
    $.session.usage(),
    $.clock.now(),
    $.process.run(['git', 'branch', '--show-current']).catch(() => null),
  ])
  await update($, view, () => ({
    tokens: usage.context.tokens ?? 0,
    percent: usage.context.percent ?? 0,
    model,
    effort,
    folder: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
    branch: git?.exitCode === 0 ? git.stdout.trim() : '',
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

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    const now = await read($, view)

    if (now.model === '') {
      return hint
    }

    const { Box, Text } = $.ui.resolve(e)
    const dot = <Text dimColor> · </Text>
    const row = (label: string, percent: number, color: string) => [
      <Text bold>{`${label}:`.padEnd(9)}</Text>,
      <Text color={color}>{'█'.repeat(cells(percent))}</Text>,
      <Text color="inactive">{'░'.repeat(BAR - cells(percent))}</Text>,
    ]

    return (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text>{now.model}</Text>
          {now.effort !== '' && dot}
          {now.effort !== '' && <Text color="claude">{now.effort}</Text>}
          {dot}
          <Text dimColor>{now.folder}</Text>
          {now.branch !== '' && <Text color="suggestion">{` (${now.branch})`}</Text>}
        </Text>
        <Text wrap="truncate-end">
          {row('Context', now.percent, heat(now.percent))}
          <Text bold color={heat(now.percent)}>{` ${short(now.tokens)}`}</Text>
          <Text>{` (${now.percent}%)`}</Text>
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
        {hint}
      </Box>
    )
  })
}
