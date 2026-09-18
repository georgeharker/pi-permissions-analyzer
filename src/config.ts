/**
 * Config loading for pi-permission-auto-review.
 *
 * Reads the auto-review extension config from global + project paths,
 * so the probe can use the same model/provider/policy the reviewer uses.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const EXTENSION_ID = 'pi-permission-auto-review'

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export interface AutoReviewConfig {
  provider: string
  model: string
  reasoning: ReasoningLevel
  timeoutMs: number
  includeBaselinePolicy: boolean
  additionalPolicy?: string
}

export const DEFAULT_CONFIG: AutoReviewConfig = {
  provider: 'openai-codex',
  model: 'codex-auto-review',
  reasoning: 'low',
  timeoutMs: 90_000,
  includeBaselinePolicy: true,
}

export function defaultAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

export function getAutoReviewConfigPaths(cwd: string, agentDir?: string): { globalPath: string; projectPath: string } {
  const base = agentDir ?? defaultAgentDir()
  return {
    globalPath: join(base, 'extensions', EXTENSION_ID, 'config.json'),
    projectPath: join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

export function loadAutoReviewConfig(cwd: string, agentDir?: string): AutoReviewConfig {
  const { globalPath, projectPath } = getAutoReviewConfigPaths(cwd, agentDir)

  let globalConfig: Partial<AutoReviewConfig> = {}
  let projectConfig: Partial<AutoReviewConfig> = {}

  try {
    if (existsSync(globalPath)) globalConfig = JSON.parse(readFileSync(globalPath, 'utf8'))
  } catch {
    /* config file missing or invalid — use defaults */
  }
  try {
    if (existsSync(projectPath)) projectConfig = JSON.parse(readFileSync(projectPath, 'utf8'))
  } catch {
    /* config file missing or invalid — use defaults */
  }

  return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig }
}
