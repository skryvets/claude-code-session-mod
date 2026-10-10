import { expect, mock, test } from 'claude-code/testing'
import type { ContextCategory, On, SessionRateLimit } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const session = (
  on: On,
  rateLimits: SessionRateLimit[],
  tokens = () => 46100,
  categories?: ContextCategory[],
) => {
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
      context: {
        tokens: tokens(),
        window: 200000,
        percent: 23,
        ...(categories && {
          breakdown: {
            categories,
            totalTokens: tokens(),
            maxTokens: 200000,
            rawMaxTokens: 200000,
            autocompactSource: 'model-default',
            percentage: 23,
            gridRows: [],
            model: 'opus',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            isAutoCompactEnabled: true,
            apiUsage: null,
          },
        }),
      },
      rateLimits,
    },
  }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>band below</Text>
  })
}

test('context, model, folder and limit pace are drawn above the prompt', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session', surface, ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

    for (const part of [
      'Opus 5.5',
      '~/Code/app',
      '(main)',
      'Context: ',
      `${'█'.repeat(6)}${'░'.repeat(18)}`,
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
      'band below',
    ]) {
      expect(texts).toContain(part)
    }

    await ui.unmount()
  }
})

test('pace is held back until 3% of the window has passed', async ($, on) => {
  session(on, [{ kind: 'seven_day', percentUsed: 4, resetsAt: '2026-10-17T09:00:00Z' }])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
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

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('on pace')
  expect(texts).toContain('runs out in 4d 22h')
  expect(texts).toContain('resets in 5d 4h')
})

test('context is read again after a compaction', async ($, on) => {
  let tokens = 201800

  session(on, [], () => tokens)
  on('session.compact', (_, e) => ({ messages: [...e.messages] }))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  tokens = 51600
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('51.6K')
  expect(texts).not.toContain('201.8K')
})

test('context is drawn as one bar stacked by what fills the window', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: kind === 'deferred',
  })

  session(on, [], () => 46100, [
    row('System prompt', 3000),
    row('System tools', 16000),
    row('MCP tools (deferred)', 40000, 'deferred'),
    row('Skills', 0),
    row('Messages', 27100),
    row('Autocompact buffer', 33000, 'buffer'),
    row('Free space', 120900, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: █${'██'}${'███'}${'░'.repeat(14)}▒▒▒▒ 46.1K (23%) · ■ msgs  ■ tools  ■ system  ▒ buffer`)
  expect(texts.join('|')).not.toContain('deferred')
  expect(texts.join('|')).not.toContain('skills')
})

test('a limit with any usage fills at least one cell', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 1, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.some(text => text.startsWith(`Session: ${'░'.repeat(24)} 0% used`))).toBe(true)
  expect(texts.some(text => text.startsWith(`Weekly:  █${'░'.repeat(23)} 1% used`))).toBe(true)
})

test('the band is left to a survey', async ($, on) => {
  session(on, [])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({
    plugin: 'session',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toEqual(['band below'])
})
