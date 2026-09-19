/**
 * Permission review log reader.
 *
 * Reads pi-permission-system's JSONL log and presents:
 *   - Summary stats (event counts, auto-review decisions by outcome)
 *   - Recent decisions (tail -n, filterable by outcome/surface)
 *   - A single decision by requestId
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_LOG_PATH = join(
  homedir(),
  '.config',
  'pi',
  'agent',
  'extensions',
  'pi-permission-system',
  'logs',
  'pi-permission-system-permission-review.jsonl',
)

// ─── Types ────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string
  extension: string
  stream: string
  event: string
  [key: string]: unknown
}

interface AutoReviewDecision extends LogEntry {
  event: 'auto_review.decision'
  requestId: string
  provider: string
  model: string
  riskLevel: string
  outcome: 'allow' | 'deny'
  durationMs: number
  transcriptEntriesRetained: number
  transcriptEntriesOmitted: number
}

interface PermissionResolved extends LogEntry {
  event: string
  source: string
  toolName: string
  command?: string
  surface: string
  matchedPattern?: string
  requestId: string
  resolution: string
  decidedBy?: Record<string, unknown>
  origin?: string
}

export interface LogSummary {
  totalEntries: number
  logPath: string
  logSizeBytes: number
  oldestTimestamp: string | null
  newestTimestamp: string | null
  eventCounts: Record<string, number>
  autoReviewDecisions: {
    total: number
    allow: number
    deny: number
    byRiskLevel: Record<string, number>
    avgDurationMs: number | null
  }
}

export interface LogDecision {
  timestamp: string
  requestId: string
  outcome: 'allow' | 'deny'
  riskLevel: string
  durationMs: number
  provider: string
  model: string
  transcriptRetained: number
  transcriptOmitted: number
}

export interface LogResolution {
  timestamp: string
  event: string
  toolName: string
  command: string
  surface: string
  matchedPattern: string
  resolution: string
  decidedBy: string
  requestId: string
}

// ─── Parsing ──────────────────────────────────────────────────────────────

function parseLines(text: string): LogEntry[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) as LogEntry } catch { return null }
    })
    .filter((e): e is LogEntry => e !== null)
}

function tailLines(text: string, n: number): LogEntry[] {
  const lines = text.split('\n').filter((l) => l.trim())
  const tail = lines.slice(-n)
  return tail
    .map((l) => {
      try { return JSON.parse(l) as LogEntry } catch { return null }
    })
    .filter((e): e is LogEntry => e !== null)
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getLogSummary(logPath: string = DEFAULT_LOG_PATH): LogSummary | null {
  if (!existsSync(logPath)) return null
  const stat = statSync(logPath)
  const text = readFileSync(logPath, 'utf8')
  const entries = parseLines(text)

  if (entries.length === 0) {
    return {
      totalEntries: 0,
      logPath,
      logSizeBytes: stat.size,
      oldestTimestamp: null,
      newestTimestamp: null,
      eventCounts: {},
      autoReviewDecisions: { total: 0, allow: 0, deny: 0, byRiskLevel: {}, avgDurationMs: null },
    }
  }

  const eventCounts: Record<string, number> = {}
  for (const e of entries) {
    eventCounts[e.event] = (eventCounts[e.event] ?? 0) + 1
  }

  const decisions = entries.filter((e) => e.event === 'auto_review.decision') as AutoReviewDecision[]
  let allow = 0, deny = 0
  const byRiskLevel: Record<string, number> = {}
  let totalDuration = 0
  for (const d of decisions) {
    if (d.outcome === 'allow') allow++
    else if (d.outcome === 'deny') deny++
    byRiskLevel[d.riskLevel] = (byRiskLevel[d.riskLevel] ?? 0) + 1
    totalDuration += d.durationMs
  }

  return {
    totalEntries: entries.length,
    logPath,
    logSizeBytes: stat.size,
    oldestTimestamp: entries[0]?.timestamp ?? null,
    newestTimestamp: entries.at(-1)?.timestamp ?? null,
    eventCounts,
    autoReviewDecisions: {
      total: decisions.length,
      allow,
      deny,
      byRiskLevel,
      avgDurationMs: decisions.length > 0 ? Math.round(totalDuration / decisions.length) : null,
    },
  }
}

export interface LogFilter {
  outcome?: 'allow' | 'deny'
  surface?: string
  limit?: number
}

export function getRecentDecisions(
  logPath: string = DEFAULT_LOG_PATH,
  filter: LogFilter = {},
): LogDecision[] {
  if (!existsSync(logPath)) return []
  const text = readFileSync(logPath, 'utf8')
  // Read last 5000 lines to find recent decisions without parsing the whole file
  const entries = tailLines(text, 5000)
  const decisions = entries
    .filter((e) => e.event === 'auto_review.decision') as AutoReviewDecision[]

  return decisions
    .filter((d) => {
      if (filter.outcome && d.outcome !== filter.outcome) return false
      return true
    })
    .map((d) => ({
      timestamp: d.timestamp,
      requestId: d.requestId,
      outcome: d.outcome,
      riskLevel: d.riskLevel,
      durationMs: d.durationMs,
      provider: d.provider,
      model: d.model,
      transcriptRetained: d.transcriptEntriesRetained,
      transcriptOmitted: d.transcriptEntriesOmitted,
    }))
    .slice(-(filter.limit ?? 20))
}

export function getRecentResolutions(
  logPath: string = DEFAULT_LOG_PATH,
  filter: LogFilter = {},
): LogResolution[] {
  if (!existsSync(logPath)) return []
  const text = readFileSync(logPath, 'utf8')
  const entries = tailLines(text, 5000)

  const resolutionEvents = new Set([
    'permission_request.approved',
    'permission_request.auto_approved',
    'permission_request.blocked',
    'permission_request.infrastructure_auto_allowed',
    'permission_request.session_approved',
  ])

  const filtered = entries
    .filter((e) => resolutionEvents.has(e.event)) as PermissionResolved[]

  return filtered
    .filter((e) => {
      if (filter.surface && e.surface !== filter.surface) return false
      return true
    })
    .map((e) => ({
      timestamp: e.timestamp,
      event: e.event,
      toolName: e.toolName,
      command: e.command ?? '',
      surface: e.surface,
      matchedPattern: e.matchedPattern ?? '',
      resolution: e.resolution,
      decidedBy: e.decidedBy ? JSON.stringify(e.decidedBy) : '',
      requestId: e.requestId,
    }))
    .slice(-(filter.limit ?? 30))
}

export function getLastResolution(
  logPath: string = DEFAULT_LOG_PATH,
): { surface: string; toolName: string; command: string; matchedPattern: string; resolution: string } | null {
  if (!existsSync(logPath)) return null
  const text = readFileSync(logPath, 'utf8')
  const entries = tailLines(text, 2000)

  const resolutionEvents = new Set([
    'permission_request.approved',
    'permission_request.auto_approved',
    'permission_request.blocked',
    'permission_request.infrastructure_auto_allowed',
    'permission_request.session_approved',
  ])

  // Walk backwards to find the most recent resolution
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as PermissionResolved
    if (resolutionEvents.has(e.event)) {
      return {
        surface: e.surface,
        toolName: e.toolName,
        command: e.command ?? '',
        matchedPattern: e.matchedPattern ?? '',
        resolution: e.resolution,
      }
    }
  }
  return null
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}
