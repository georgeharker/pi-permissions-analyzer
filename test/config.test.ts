import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAutoReviewConfig,
  DEFAULT_CONFIG,
  getAutoReviewConfigPaths,
  loadAnalyzerPresets,
  DEFAULT_PRESETS,
  getAnalyzerConfigPath,
} from '../src/config.js'

function withTempAgentDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'perms-analyzer-test-'))
  fn(dir)
}

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

describe('getAnalyzerConfigPath', () => {
  it('points at extensions/pi-permissions-analyzer.json in the agent dir', () => {
    const path = getAnalyzerConfigPath('/tmp/agent-dir')
    expect(path).toBe(join('/tmp/agent-dir', 'extensions', 'pi-permissions-analyzer.json'))
  })
})

describe('loadAnalyzerPresets', () => {
  it('returns built-in defaults when no config file exists', () => {
    withTempAgentDir((dir) => {
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('defaults')
      expect(result.presets).toEqual(DEFAULT_PRESETS)
      expect(result.path).toBe(join(dir, 'extensions', 'pi-permissions-analyzer.json'))
    })
  })

  it('overrides presets from the config file (shorthand entries)', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(
        join(ext, 'pi-permissions-analyzer.json'),
        JSON.stringify({
          presets: [
            { label: '🧪  git push --force', command: 'git push --force', surface: 'bash', toolName: 'bash' },
            { label: '🧪  docker system prune', command: 'docker system prune -af', surface: 'bash' },
          ],
        }),
      )
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('file')
      expect(result.presets).toHaveLength(2)
      expect(result.presets[0]).toEqual({
        label: '🧪  git push --force',
        overrides: { command: 'git push --force', surface: 'bash', toolName: 'bash' },
      })
      // shorthand without toolName still works
      expect(result.presets[1]!.overrides['command']).toBe('docker system prune -af')
    })
  })

  it('accepts explicit overrides objects', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(
        join(ext, 'pi-permissions-analyzer.json'),
        JSON.stringify({
          presets: [{ label: 'x', overrides: { command: 'ls', surface: 'bash', matchedPattern: 'ls' } }],
        }),
      )
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('file')
      expect(result.presets[0]!.overrides).toEqual({ command: 'ls', surface: 'bash', matchedPattern: 'ls' })
    })
  })

  it('skips invalid entries but keeps valid ones', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(
        join(ext, 'pi-permissions-analyzer.json'),
        JSON.stringify({
          presets: [
            'not an object',
            { overrides: { command: 'ls' } }, // no label
            { label: '', command: 'ls' }, // empty label
            { label: 'ok', overrides: 'not an object' }, // bad overrides
            { label: 'valid', command: 'pwd' },
          ],
        }),
      )
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('file')
      expect(result.presets).toHaveLength(1)
      expect(result.presets[0]!.label).toBe('valid')
    })
  })

  it('respects an explicit empty presets array', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(join(ext, 'pi-permissions-analyzer.json'), JSON.stringify({ presets: [] }))
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('file')
      expect(result.presets).toEqual([])
    })
  })

  it('falls back to defaults on invalid JSON', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(join(ext, 'pi-permissions-analyzer.json'), '{ not json ]')
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('defaults')
      expect(result.presets).toEqual(DEFAULT_PRESETS)
    })
  })

  it('falls back to defaults when presets is not an array', () => {
    withTempAgentDir((dir) => {
      const ext = join(dir, 'extensions')
      mkdirSync(ext, { recursive: true })
      writeFileSync(join(ext, 'pi-permissions-analyzer.json'), JSON.stringify({ presets: 'nope' }))
      const result = loadAnalyzerPresets(dir)
      expect(result.source).toBe('defaults')
      expect(result.presets).toEqual(DEFAULT_PRESETS)
    })
  })
})
