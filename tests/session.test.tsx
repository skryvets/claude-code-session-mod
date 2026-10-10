import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const HINT = {
  component: 'PromptHint',
  viewport: { columns: 120, rows: 40 },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const session = (on: On, rateLimits: SessionRateLimit[]) => {
  mock.clock(on, { now: Date.parse('2026-10-10T10:00:00Z') })
  mock.env(on, { HOME: '/Users/me' })
  on('session.cwd', () => ({ value: '/Users/me/Code/app' }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'main\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 46100, window: 200000, percent: 23 },
      rateLimits,
    },
  }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.hint}</Text>
  })
}

test('context, model, folder and limit pace are drawn under the prompt', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session', surface, ...HINT })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

    for (const part of [
      'Opus 5.5',
      '~/Code/app',
      '(main)',
      'Context: ',
      '██░░░░░░',
      '46.1K',
      '(23%)',
      'Session: ',
      '66% used',
      '7% in reserve',
      'lasts until reset',
      'resets in 1h 22m',
      'Weekly:  ',
      '60% used',
      '17% in deficit',
      'runs out in 2d 0h',
      'resets in 4d 0h',
      '? for shortcuts',
    ]) {
      expect(texts).toContain(part)
    }

    await ui.unmount()
  }
})

test('pace is held back until 3% of the window has passed', async ($, on) => {
  session(on, [{ kind: 'seven_day', percentUsed: 4, resetsAt: '2026-10-17T09:00:00Z' }])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...HINT })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('4% used')
  expect(texts).toContain('resets in 6d 23h')
  expect(texts).not.toContain('pace')
  expect(texts).not.toContain('deficit')
  expect(texts).not.toContain('runs out')
})

test('on pace can still forecast running out, as CodexBar does', async ($, on) => {
  session(on, [{ kind: 'seven_day', percentUsed: 27, resetsAt: '2026-10-15T14:00:00Z' }])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...HINT })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('on pace')
  expect(texts).toContain('runs out in 4d 22h')
  expect(texts).toContain('resets in 5d 4h')
})
