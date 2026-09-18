import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, buildSystemPrompt } from '../src/prompt.js'
import { loadAutoReviewConfig, DEFAULT_CONFIG } from '../src/config.js'
import type { AutoReviewConfig } from '../src/config.js'

describe('buildSystemPrompt', () => {
  it('includes the review protocol', () => {
    const prompt = buildSystemPrompt(DEFAULT_CONFIG)
    expect(prompt).toContain('read-only automatic permission reviewer')
    expect(prompt).toContain('Baseline Guardian policy included')
  })

  it('includes additionalPolicy as Operator Policy', () => {
    const config: AutoReviewConfig = {
      ...DEFAULT_CONFIG,
      additionalPolicy: 'Deny all npm publish operations.',
    }
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('Operator Policy')
    expect(prompt).toContain('Deny all npm publish operations.')
    expect(prompt).toContain('more restrictive outcome')
  })

  it('replaces baseline when disabled', () => {
    const config: AutoReviewConfig = {
      ...DEFAULT_CONFIG,
      includeBaselinePolicy: false,
      additionalPolicy: 'Custom risk taxonomy.',
    }
    const prompt = buildSystemPrompt(config)
    expect(prompt).toContain('disabled the built-in Guardian policy')
    expect(prompt).toContain('Custom risk taxonomy.')
    expect(prompt).toContain('independently controls risk taxonomy')
  })

  it('omits operator policy section when no additionalPolicy', () => {
    const prompt = buildSystemPrompt(DEFAULT_CONFIG)
    expect(prompt).not.toContain('Operator Policy')
  })
})

describe('buildReviewPrompt', () => {
  it('builds both system and user prompts', () => {
    const config = DEFAULT_CONFIG
    const transcript = { entries: [], stats: { transcriptEntriesRetained: 0, transcriptEntriesOmitted: 0, transcriptEntriesTruncated: 0, latestTrustedEntryRetained: false } }
    const details = {
      requestId: 'test-1',
      source: 'tool_call',
      agentName: null,
      payload: { kind: 'bash' },
      toolName: 'bash',
      command: 'echo hello',
      surface: 'bash',
    }

    const result = buildReviewPrompt(config, transcript, details)

    expect(result.systemPrompt).toContain('read-only automatic permission reviewer')
    expect(result.userPrompt).toContain('TRANSCRIPT JSONL START')
    expect(result.userPrompt).toContain('PERMISSION REQUEST START')
    expect(result.userPrompt).toContain('echo hello')
  })

  it('includes transcript entries when present', () => {
    const config = DEFAULT_CONFIG
    const transcript = {
      entries: ['{"index":0,"source":"user","label":"user","content":"Run the tests"}'],
      stats: { transcriptEntriesRetained: 1, transcriptEntriesOmitted: 0, transcriptEntriesTruncated: 0, latestTrustedEntryRetained: true },
    }
    const details = { requestId: 'test-2', source: 'tool_call', agentName: null, payload: {}, toolName: 'bash', command: 'ls', surface: 'bash' }

    const result = buildReviewPrompt(config, transcript, details)
    expect(result.userPrompt).toContain('Run the tests')
  })
})
