import { describe, expect, it } from 'vitest'
import { loadAutoReviewConfig, DEFAULT_CONFIG, getAutoReviewConfigPaths } from '../src/config.js'

describe('loadAutoReviewConfig', () => {
  it('returns defaults when no config files exist', () => {
    const config = loadAutoReviewConfig('/nonexistent/path', '/nonexistent/agent')
    expect(config.provider).toBe(DEFAULT_CONFIG.provider)
    expect(config.model).toBe(DEFAULT_CONFIG.model)
    expect(config.reasoning).toBe(DEFAULT_CONFIG.reasoning)
    expect(config.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
    expect(config.includeBaselinePolicy).toBe(true)
  })
})

describe('getAutoReviewConfigPaths', () => {
  it('returns global and project paths', () => {
    const { globalPath, projectPath } = getAutoReviewConfigPaths('/tmp/project')
    expect(globalPath).toContain('pi-permission-auto-review')
    expect(globalPath).toContain('config.json')
    expect(projectPath).toContain('/tmp/project')
    expect(projectPath).toContain('pi-permission-auto-review')
  })
})
