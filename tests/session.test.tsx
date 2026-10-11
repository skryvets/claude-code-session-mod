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
  tokens: () => number | undefined = () => 46100,
  categories?: ContextCategory[],
) => {
  const estimate = (categories ?? []).reduce(
    (sum, { tokens, kind }) => (kind === 'used' ? sum + tokens : sum),
    0,
  )

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
        ...(tokens() !== undefined && { tokens: tokens()!, percent: 23 }),
        window: 200000,
        ...(categories && {
          breakdown: {
            categories,
            totalTokens: estimate,
            maxTokens: 200000,
            rawMaxTokens: 200000,
            autocompactSource: 'model-default',
            percentage: Math.round(estimate / 2000),
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
      `Session: ${'█'.repeat(16)}█${'░'.repeat(7)} 66% used`,
      '7% in reserve',
      'lasts until reset',
      'resets in 1h 22m',
      `Weekly:  ${'█'.repeat(10)}░░░░█${'░'.repeat(9)} 60% used`,
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

  expect(texts).toContain(`Weekly:  ░█${'░'.repeat(22)} 4% used`)
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

  expect(texts).toContain(`Context: ▌█▌███${'░'.repeat(14)}▒▒▒▒ 46.1K (23%) · ■ msgs  ■ tools  ■ system  ▒ buffer`)
  const halves = (await ui.findAll({ type: 'Text', text: '▌' })).filter(found => found.text === '▌')

  expect(halves.map(found => found.props.backgroundColor)).toEqual(['#7dcfff', 'claude'])
  expect(texts.join('|')).not.toContain('deferred')
  expect(texts.join('|')).not.toContain('skills')
})

test('a fresh session shows the estimated context until the first response', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: false,
  })

  session(on, [], () => undefined, [
    row('System prompt', 4000),
    row('System tools', 18000),
    row('Skills', 0),
    row('Messages', 0),
    row('Autocompact buffer', 33000, 'buffer'),
    row('Free space', 145000, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: ▌██${'░'.repeat(17)}▒▒▒▒ 22.0K (11%) · ■ tools  ■ system  ▒ buffer`)
})

test('the band keeps a blank row above and between lines only while they fit', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  for (const [maxRows, space] of [
    [8, 1],
    [7, 0],
    [4, 0],
  ] as const) {
    const ui = await $.ui.mount({
      plugin: 'session',
      surface: 'terminal',
      ...BAND,
      props: { ...BAND.props, maxRows },
    })
    const box = (await ui.findAll({ type: 'Box' }))[0]!

    expect(box.props.gap).toBe(space)
    expect(box.props.paddingTop).toBe(space)
    await ui.unmount()
  }
})

test('a category takes its true share of the bar, down to no cell at all', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: false,
  })

  session(on, [], () => 30500, [
    row('System prompt', 300),
    row('Memory files', 200),
    row('Messages', 30000),
    row('Free space', 169500, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const filled = await ui.findAll({ type: 'Text', text: '█' })

  expect(texts).toContain(`Context: ████${'░'.repeat(20)} 30.5K (23%) · ■ msgs  ■ system  ■ memory`)
  expect(filled.filter(found => found.text === '█').every(found => found.props.color === 'claude')).toBe(true)
})

test('a lone small category still fills one whole cell', async ($, on) => {
  session(on, [], () => 500, [
    { name: 'System prompt', tokens: 500, kind: 'used', color: 'inactive', isDeferred: false },
    { name: 'Free space', tokens: 199500, kind: 'free', color: 'inactive', isDeferred: false },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: █${'░'.repeat(23)} 500 (23%) · ■ system`)
})

test('the fill follows the time passed, whatever the usage', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 1, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.some(text => text.startsWith(`Session: █${'█'.repeat(16)}${'░'.repeat(7)} 0% used`))).toBe(true)
  expect(texts.some(text => text.startsWith(`Weekly:  █${'█'.repeat(9)}${'░'.repeat(14)} 1% used`))).toBe(true)
})

test('the fill takes the elapsed colour and the marker its own', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const colors = async (glyph: string) =>
    (await ui.findAll({ type: 'Text', text: glyph }))
      .filter(found => found.text === glyph)
      .map(found => found.props.color)

  expect((await colors('█')).slice(-28)).toEqual([
    ...Array(16).fill('#999999'),
    '#333131',
    ...Array(10).fill('#999999'),
    '#333131',
  ])
  expect(texts.some(text => text.startsWith(`Weekly:  ${'█'.repeat(10)}${'░'.repeat(13)}█ 100% used`))).toBe(true)
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

test('the band is drawn again after a /clear', async ($, on) => {
  session(on, [])
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'clear' })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('Opus 5.5')
  expect(texts).toContain('46.1K')
})
