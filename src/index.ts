/**
 * @geohar/pi-permissions-analyzer — Analyze and probe the pi-permission-auto-review classifier.
 *
 * Lets you test the classifier in isolation by:
 *   1. Building the exact prompt the reviewer would send (dry run)
 *   2. Calling the configured model with that prompt and showing the verdict
 *   3. Querying the live permission system to show what the deterministic rules say
 *
 * Usage (inside pi):
 *   /permissions-analyzer                  — show help / usage
 *   /permissions-analyzer dry              — dump the system + user prompt + policy check
 *   /permissions-analyzer call             — call the model and show the verdict
 *   /permissions-analyzer config           — show the active auto-review config
 *   /permissions-analyzer scenario [JSON]  — show/override the permission scenario
 *   /permissions-analyzer log [N]          — show last N review decisions + resolutions from the log
 *   /permissions-analyzer call --scenario <json>  — override permission details with a custom scenario
 *
 * The analyzer reads your existing auto-review config, builds the real transcript
 * from the current session, queries the live permission system, and constructs
 * the exact prompt the reviewer uses.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessage, Model, Provider, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { homedir } from 'node:os'
import { getPermissionsService, PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import type { PermissionCheckResult, PermissionsReadyEvent } from '@gotgenes/pi-permission-system'
import { loadAutoReviewConfig } from './config.js'
import { buildReviewPrompt, type PermissionDetails } from './prompt.js'
import { parseReviewAssessment } from './verdict.js'
import { renderTranscript } from './transcript.js'
import { getLogSummary, getRecentDecisions, getRecentResolutions, formatTimestamp, DEFAULT_LOG_PATH } from './log.js'

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const DEFAULT_SCENARIO: PermissionDetails = {
  requestId: 'probe-test-1',
  source: 'tool_call',
  agentName: null,
  payload: {
    kind: 'bash',
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: 'bash',
      toolName: 'bash',
      invokedToolName: null,
      value: 'echo $HOME',
      matchedPattern: 'echo *',
      commandContext: null,
      executedUnit: null,
    },
    evidence: [{ label: 'command', text: 'echo $HOME', detail: null }],
    annotations: [],
  },
  toolName: 'bash',
  command: 'echo $HOME',
  surface: 'bash',
}

async function callModel(
  provider: Provider<Api>,
  model: Model<Api>,
  systemPrompt: string,
  userPrompt: string,
  streamOpts: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const stream = provider.streamSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
    },
    streamOpts,
  )
  return stream.result()
}

function responseText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

function parseScenarioArg(parts: string[]): Record<string, unknown> {
  const idx = parts.indexOf('--scenario')
  if (idx < 0 || !parts[idx + 1]) return {}
  try {
    return JSON.parse(parts.slice(idx + 1).join(' '))
  } catch {
    return {}
  }
}

interface PolicyCheck {
  surface: string
  value: string
  result: PermissionCheckResult | null
  available: boolean
}

function queryPolicy(sessionId: string | undefined, surface: string, value: string): PolicyCheck {
  if (sessionId === undefined) {
    return { surface, value, result: null, available: false }
  }
  const service = getPermissionsService(sessionId)
  if (service === undefined) {
    return { surface, value, result: null, available: false }
  }
  try {
    const result = service.checkPermission(surface, value)
    return { surface, value, result, available: true }
  } catch {
    return { surface, value, result: null, available: false }
  }
}

function formatPolicyCheck(check: PolicyCheck): string[] {
  if (!check.available) {
    return ['Permission system: not available (no sessionId or service not ready)']
  }
  if (check.result === null) {
    return ['Permission system: query failed']
  }
  const r = check.result
  return [
    '─── PERMISSION SYSTEM (deterministic rules) ───',
    `  Surface:   ${r.toolName}`,
    `  Value:     ${check.value}`,
    `  State:     ${r.state}`,
    `  Origin:    ${r.origin}`,
    `  Pattern:   ${r.matchedPattern ?? '(none)'}`,
    `  Command:   ${r.command ?? '(none)'}`,
    '',
    `The deterministic rules say "${r.state}" (from ${r.origin}).`,
    'The authorizer chain runs AFTER these rules — it can only',
    '  - allow when state is "ask" (auto-approve)',
    '  - deny (auto-deny)',
    '  - defer (let the human decide)',
    'It CANNOT override a config-level "allow" or "deny".',
  ]
}

export default function permissionsAnalyzer(pi: ExtensionAPI): void {
  // Capture the session ID from pi-permission-system's ready event.
  // The service is session-keyed: one Pi process hosts several nodes
  // (root session + in-process subagents), each publishing under its own ID.
  let sessionId: string | undefined

  pi.events.on(PERMISSIONS_READY_CHANNEL, (data: unknown) => {
    const ready = data as PermissionsReadyEvent | undefined
    const id = ready?.sessionId
    if (id != null) {
      // Learn-once: ready repeats, so this is not last-writer-wins.
      sessionId ??= id
    }
  })

  pi.on('session_shutdown', () => {
    sessionId = undefined
  })

  pi.registerCommand('permissions-analyzer', {
    description: 'Analyze the auto-review classifier: help | dry | call | config | scenario | log',
    handler: async (args, ctx) => {
      const parts = (args ?? '').trim().split(/\s+/)
      const subcommand = parts[0] ?? 'dry'
      const config = loadAutoReviewConfig(ctx.cwd)

      const branch = ctx.sessionManager.getBranch()
      const transcript = renderTranscript(branch)
      const scenarioOverrides = parseScenarioArg(parts)
      const details: PermissionDetails = { ...DEFAULT_SCENARIO, ...scenarioOverrides }

      const { systemPrompt, userPrompt } = buildReviewPrompt(config, transcript, details)

      // Query the live permission system for the scenario's surface + value
      const surface = typeof details.surface === 'string' ? details.surface : 'bash'
      const value = typeof details.command === 'string' ? details.command : (details.value ?? 'echo $HOME')
      const policyCheck = queryPolicy(sessionId, surface, value)

      if (subcommand === 'dry') {
        const output = [
          '╔══════════════════════════════════════════════════════╗',
          '║  PERMISSIONS ANALYZER — DRY RUN                       ║',
          '╚══════════════════════════════════════════════════════╝',
          '',
          `Config: provider=${config.provider} model=${config.model} reasoning=${config.reasoning}`,
          `Baseline policy: ${config.includeBaselinePolicy ? 'ON' : 'OFF'}`,
          `Additional policy: ${config.additionalPolicy ? 'YES' : 'none'}`,
          '',
          `Transcript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted, ${transcript.stats.transcriptEntriesTruncated} truncated`,
          `Latest trusted entry retained: ${transcript.stats.latestTrustedEntryRetained}`,
          '',
          ...formatPolicyCheck(policyCheck),
          '',
          `─── SYSTEM PROMPT (${systemPrompt.length} chars, ~${approximateTokens(systemPrompt)} tokens) ───`,
          systemPrompt,
          '',
          `─── USER PROMPT (${userPrompt.length} chars, ~${approximateTokens(userPrompt)} tokens) ───`,
          userPrompt,
        ]
        ctx.ui.notify(output.join('\n'), 'info')
        return
      }

      if (subcommand === 'call') {
        const model = ctx.modelRegistry.find(config.provider, config.model)
        if (!model) {
          ctx.ui.notify(`Model ${config.provider}/${config.model} not found in registry`, 'error')
          return
        }
        const provider = ctx.modelRegistry.getProvider(config.provider)
        if (!provider) {
          ctx.ui.notify(`Provider ${config.provider} not found`, 'error')
          return
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
        if (!auth.ok) {
          ctx.ui.notify(`Auth failed for ${config.provider}: ${auth.error}`, 'error')
          return
        }

        ctx.ui.setStatus('permissions-analyzer', 'Calling reviewer model...')

        try {
          const streamOpts: SimpleStreamOptions = {
            maxRetries: 0,
            maxTokens: 1_000,
            signal: ctx.signal,
            timeoutMs: config.timeoutMs,
          }
          if (auth.apiKey !== undefined) streamOpts.apiKey = auth.apiKey
          if (auth.headers !== undefined) streamOpts.headers = auth.headers
          if (auth.env !== undefined) streamOpts.env = auth.env
          if (model.reasoning && config.reasoning !== 'off') streamOpts.reasoning = config.reasoning as ThinkingLevel

          const message = await callModel(provider, model, systemPrompt, userPrompt, streamOpts)
          const text = responseText(message)

          let verdict: Record<string, unknown>
          try {
            const assessment = parseReviewAssessment(text)
            verdict = { ...assessment }
          } catch {
            try {
              const start = text.indexOf('{')
              const end = text.lastIndexOf('}')
              verdict = JSON.parse(text.slice(start, end + 1))
            } catch {
              verdict = { raw: text }
            }
          }

          const output = [
            '╔══════════════════════════════════════════════════════╗',
            '║  PERMISSIONS ANALYZER — LIVE CALL                     ║',
            '╚══════════════════════════════════════════════════════╝',
            '',
            `Config: provider=${config.provider} model=${config.model} reasoning=${config.reasoning}`,
            `Transcript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted`,
            '',
            ...formatPolicyCheck(policyCheck),
            '',
            '─── MODEL RESPONSE ───',
            text,
            '',
            '─── PARSED VERDICT ───',
            JSON.stringify(verdict, null, 2),
            '',
            '─── SCENARIO DETAILS ───',
            JSON.stringify(details, null, 2),
          ]

        ctx.ui.notify(output.join('\n'), 'info')
        } catch (err) {
          ctx.ui.setStatus('permissions-analyzer', '')
          ctx.ui.notify(`Probe failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
        return
      }

      if (subcommand === 'help' || subcommand === '' || subcommand === '--help' || subcommand === '-h') {
        const output = [
          '╔══════════════════════════════════════════════════════╗',
          '║  PERMISSIONS ANALYZER — HELP                         ║',
          '╚══════════════════════════════════════════════════════╝',
          '',
          'Probes the pi-permission-auto-review classifier in isolation.',
          'Also queries the live permission system to show deterministic rules.',
          '',
          '─── COMMANDS ───',
          '',
          '  /permissions-analyzer                  Show this help',
          '  /permissions-analyzer help             Show this help',
          '  /permissions-analyzer dry              Build prompt + policy check (no model call)',
          '  /permissions-analyzer call             Call the reviewer model and show verdict',
          '  /permissions-analyzer config           Show the active auto-review config',
          '  /permissions-analyzer scenario [JSON]  Show/override the permission scenario',
          '  /permissions-analyzer log [N]          Show last N review decisions + resolutions',
          '',
          '─── OPTIONS ───',
          '',
          '  --scenario {"command":"...","surface":"bash"}',
          '    Override permission request fields for dry/call.',
          '    Example:',
          '      /permissions-analyzer call --scenario {"command":"cat ~/.cache/secrets/key"}',
          '',
          '─── CONFIG ───',
          '',
          `  Provider:   ${config.provider}`,
          `  Model:      ${config.model}`,
          `  Reasoning:  ${config.reasoning}`,
          `  Timeout:    ${config.timeoutMs}ms`,
          `  Baseline:   ${config.includeBaselinePolicy ? 'ON' : 'OFF'}`,
          `  Additional: ${config.additionalPolicy ? 'YES (' + config.additionalPolicy.length + ' chars)' : 'none'}`,
          '',
          '─── LLM TOOL ───',
          '',
          '  The permissions_analyzer tool is also available to the',
          '  model. Use mode="dry" to inspect the prompt without',
          '  cost, mode="call" to get an actual verdict.',
        ]
        ctx.ui.notify(output.join('\n'), 'info')
        return
      }

      if (subcommand === 'config') {
        const output = [
          '╔══════════════════════════════════════════════════════╗',
          '║  PERMISSIONS ANALYZER — CONFIG                        ║',
          '╚══════════════════════════════════════════════════════╝',
          '',
          `  Provider:     ${config.provider}`,
          `  Model:        ${config.model}`,
          `  Reasoning:    ${config.reasoning}`,
          `  Timeout:      ${config.timeoutMs}ms`,
          `  Baseline:     ${config.includeBaselinePolicy ? 'ON' : 'OFF'}`,
          `  Additional:   ${config.additionalPolicy ? 'YES' : 'none'}`,
        ]
        if (config.additionalPolicy) {
          output.push('', '  ─── Additional Policy ───', '', ...config.additionalPolicy.split('\n').map(l => '  ' + l))
        }
        ctx.ui.notify(output.join('\n'), 'info')
        return
      }

      if (subcommand === 'scenario') {
        const overrides = parseScenarioArg(parts)
        const scenario: PermissionDetails = { ...DEFAULT_SCENARIO, ...overrides }
        const output = [
          '╔══════════════════════════════════════════════════════╗',
          '║  PERMISSIONS ANALYZER — SCENARIO                     ║',
          '╚══════════════════════════════════════════════════════╝',
          '',
          '  Default scenario with any --scenario overrides applied:',
          '',
          ...JSON.stringify(scenario, null, 2).split('\n').map(l => '  ' + l),
          '',
          '  Use with dry/call:',
          '    /permissions-analyzer dry --scenario {"command":"rm -rf /"}',
        ]
        ctx.ui.notify(output.join('\n'), 'info')
        return
      }

      if (subcommand === 'log') {
        const n = parseInt(parts[1] ?? '20', 10) || 20
        const summary = getLogSummary(DEFAULT_LOG_PATH)

        if (!summary) {
          ctx.ui.notify(`Log not found at ${DEFAULT_LOG_PATH}`, 'error')
          return
        }

        const decisions = getRecentDecisions(DEFAULT_LOG_PATH, { limit: n })
        const resolutions = getRecentResolutions(DEFAULT_LOG_PATH, { limit: n })

        const output = [
          '╔══════════════════════════════════════════════════════╗',
          '║  PERMISSIONS ANALYZER — REVIEW LOG                    ║',
          '╚══════════════════════════════════════════════════════╝',
          '',
          `  Log:     ${DEFAULT_LOG_PATH.replace(homedir(), '~')}`,
          `  Size:    ${(summary.logSizeBytes / 1024).toFixed(0)} KB`,
          `  Entries: ${summary.totalEntries.toLocaleString()}`,
          `  From:    ${summary.oldestTimestamp ? formatTimestamp(summary.oldestTimestamp) : '(empty)'}`,
          `  To:      ${summary.newestTimestamp ? formatTimestamp(summary.newestTimestamp) : '(empty)'}`,
          '',
          '─── AUTO-REVIEW DECISIONS ───',
          '',
          `  Total:  ${summary.autoReviewDecisions.total}`,
          `  Allow:  ${summary.autoReviewDecisions.allow}  ·  Deny: ${summary.autoReviewDecisions.deny}`,
          `  Risk:   ${Object.entries(summary.autoReviewDecisions.byRiskLevel).map(([k, v]) => `${k}: ${v}`).join('  ·  ') || 'none'}`,
          `  Avg duration: ${summary.autoReviewDecisions.avgDurationMs ?? 'n/a'}ms`,
          '',
          `─── RECENT DECISIONS (last ${decisions.length}) ───`,
          '',
        ]

        if (decisions.length === 0) {
          output.push('  (no auto_review.decision events found)')
        } else {
          for (const d of decisions) {
            const icon = d.outcome === 'allow' ? '✓' : '✗'
            output.push(
              `  ${icon} ${formatTimestamp(d.timestamp)}  ${d.outcome.toUpperCase().padEnd(5)}  risk=${d.riskLevel.padEnd(8)}  ${d.durationMs}ms  ${d.provider}/${d.model}  transcript=${d.transcriptRetained}/${d.transcriptRetained + d.transcriptOmitted}`,
            )
          }
        }

        output.push(
          '',
          `─── RECENT RESOLUTIONS (last ${resolutions.length}) ───`,
          '',
        )

        if (resolutions.length === 0) {
          output.push('  (no permission_request.* events found)')
        } else {
          for (const r of resolutions) {
            const eventShort = r.event.replace('permission_request.', '')
            const icon = eventShort === 'blocked' ? '✗' : eventShort === 'approved' ? '⏎' : '✓'
            const cmd = r.command.length > 60 ? r.command.slice(0, 57) + '…' : r.command
            output.push(
              `  ${icon} ${formatTimestamp(r.timestamp)}  ${eventShort.padEnd(26)}  ${r.surface}/${r.toolName}  ${cmd}`,
            )
          }
        }

        output.push(
          '',
          '─── EVENT COUNTS ───',
          '',
        )

        const sortedEvents = Object.entries(summary.eventCounts)
          .sort((a, b) => b[1] - a[1])
        for (const [event, count] of sortedEvents) {
          output.push(`  ${count.toString().padStart(6)}  ${event}`)
        }

        ctx.ui.notify(output.join('\n'), 'info')
        return
      }

      ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: help | dry | call | config | scenario | log`, 'error')
    },
  })

  pi.registerTool({
    name: 'permissions_analyzer',
    label: 'Permissions Analyzer',
    description:
      'Analyze the pi-permission-auto-review classifier. Returns the prompt it would receive (dry) or calls the model and returns the verdict (call). Also queries the live permission system to show deterministic rules. Use to validate how additionalPolicy rules affect decisions.',
    promptSnippet: 'Analyze the permission reviewer with dry or call mode',
    promptGuidelines: [
      'Use permissions_analyzer to test how the auto-review classifier would judge a permission request.',
      'Use mode="dry" to inspect the prompt without model cost, mode="call" to get an actual verdict.',
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal('dry'), Type.Literal('call')], {
        description:
          "'dry' to dump the prompt without calling the model, 'call' to call the model and get a verdict",
      }),
      scenario: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            'Override permission request fields, e.g. {"command": "cat ~/.cache/secrets/key", "surface": "bash"}',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadAutoReviewConfig(ctx.cwd)
      const branch = ctx.sessionManager.getBranch()
      const transcript = renderTranscript(branch)
      const details: PermissionDetails = { ...DEFAULT_SCENARIO, ...params.scenario }
      const { systemPrompt, userPrompt } = buildReviewPrompt(config, transcript, details)

      // Query live permission system
      const surface = typeof details.surface === 'string' ? details.surface : 'bash'
      const value = typeof details.command === 'string' ? details.command : (details.value ?? 'echo $HOME')
      const policyCheck = queryPolicy(sessionId, surface, value)

      const policyLines = formatPolicyCheck(policyCheck).join('\n')

      if (params.mode === 'dry') {
        return {
          content: [
            {
              type: 'text',
              text: `# Permissions Analyzer — DRY RUN\n\nConfig: provider=${config.provider} model=${config.model}\nBaseline: ${config.includeBaselinePolicy ? 'ON' : 'OFF'}\nAdditional policy: ${config.additionalPolicy ?? 'none'}\nTranscript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted\n\n${policyLines}\n\n## System Prompt (~${approximateTokens(systemPrompt)} tokens)\n\`\`\`\n${systemPrompt}\n\`\`\`\n\n## User Prompt (~${approximateTokens(userPrompt)} tokens)\n\`\`\`\n${userPrompt}\n\`\`\``,
            },
          ],
          details: { config, transcriptStats: transcript.stats, details, policyCheck },
        }
      }

      const model = ctx.modelRegistry.find(config.provider, config.model)
      const provider = ctx.modelRegistry.getProvider(config.provider)
      if (!model || !provider) {
        return {
          content: [{ type: 'text', text: `Model/provider ${config.provider}/${config.model} not found` }],
          details: {},
        }
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      if (!auth.ok) {
        return { content: [{ type: 'text', text: `Auth failed: ${auth.error}` }], details: {} }
      }

      const streamOpts: SimpleStreamOptions = {
        maxRetries: 0,
        maxTokens: 1_000,
        signal,
        timeoutMs: config.timeoutMs,
      }
      if (auth.apiKey !== undefined) streamOpts.apiKey = auth.apiKey
      if (auth.headers !== undefined) streamOpts.headers = auth.headers
      if (auth.env !== undefined) streamOpts.env = auth.env
      if (model.reasoning && config.reasoning !== 'off') streamOpts.reasoning = config.reasoning as ThinkingLevel

      const message = await callModel(provider, model, systemPrompt, userPrompt, streamOpts)
      const text = responseText(message)

      let verdict: Record<string, unknown>
      try {
        const assessment = parseReviewAssessment(text)
        verdict = { ...assessment }
      } catch {
        try {
          const start = text.indexOf('{')
          const end = text.lastIndexOf('}')
          verdict = JSON.parse(text.slice(start, end + 1))
        } catch {
          verdict = { raw: text }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `# Permissions Analyzer — LIVE CALL\n\nConfig: provider=${config.provider} model=${config.model}\n\n${policyLines}\n\n## Verdict\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\`\n\n## Scenario\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``,
          },
        ],
        details: { verdict, scenario: details, transcriptStats: transcript.stats, policyCheck },
      }
    },
  })
}
