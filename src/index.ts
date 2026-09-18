/**
 * @geohar/review-probe — Standalone probe tester for pi-permission-auto-review.
 *
 * Lets you test the classifier in isolation by:
 *   1. Building the exact prompt the reviewer would send (dry run)
 *   2. Calling the configured model with that prompt and showing the verdict
 *
 * Usage (inside pi):
 *   /review-probe dry                     — dump the system + user prompt without calling the model
 *   /review-probe call                    — call the model and show the verdict
 *   /review-probe call --scenario <json>  — override permission details with a custom scenario
 *
 * The probe reads your existing auto-review config, builds the real transcript
 * from the current session, and constructs the exact prompt the reviewer uses.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessage, Model, Provider, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { loadAutoReviewConfig } from './config.js'
import { buildReviewPrompt, type PermissionDetails } from './prompt.js'
import { parseReviewAssessment } from './verdict.js'
import { renderTranscript } from './transcript.js'

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

export default function reviewProbe(pi: ExtensionAPI): void {
  pi.registerCommand('review-probe', {
    description: 'Test the auto-review classifier in isolation: dry | call [--scenario JSON]',
    handler: async (args, ctx) => {
      const parts = (args ?? '').trim().split(/\s+/)
      const subcommand = parts[0] ?? 'dry'
      const config = loadAutoReviewConfig(ctx.cwd)

      const branch = ctx.sessionManager.getBranch()
      const transcript = renderTranscript(branch)
      const scenarioOverrides = parseScenarioArg(parts)
      const details: PermissionDetails = { ...DEFAULT_SCENARIO, ...scenarioOverrides }

      const { systemPrompt, userPrompt } = buildReviewPrompt(config, transcript, details)

      if (subcommand === 'dry') {
        const output = [
          `╔══════════════════════════════════════════════════════╗`,
          `║  REVIEW PROBE — DRY RUN                              ║`,
          `╚══════════════════════════════════════════════════════╝`,
          ``,
          `Config: provider=${config.provider} model=${config.model} reasoning=${config.reasoning}`,
          `Baseline policy: ${config.includeBaselinePolicy ? 'ON' : 'OFF'}`,
          `Additional policy: ${config.additionalPolicy ? 'YES' : 'none'}`,
          ``,
          `Transcript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted, ${transcript.stats.transcriptEntriesTruncated} truncated`,
          `Latest trusted entry retained: ${transcript.stats.latestTrustedEntryRetained}`,
          ``,
          `─── SYSTEM PROMPT (${systemPrompt.length} chars, ~${approximateTokens(systemPrompt)} tokens) ───`,
          systemPrompt,
          ``,
          `─── USER PROMPT (${userPrompt.length} chars, ~${approximateTokens(userPrompt)} tokens) ───`,
          userPrompt,
        ]
        ctx.ui.setWidget('review-probe', output)
        ctx.ui.notify('Dry run complete — see widget above', 'info')
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

        ctx.ui.setStatus('review-probe', 'Calling reviewer model...')

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
            `╔══════════════════════════════════════════════════════╗`,
            `║  REVIEW PROBE — LIVE CALL                            ║`,
            `╚══════════════════════════════════════════════════════╝`,
            ``,
            `Config: provider=${config.provider} model=${config.model} reasoning=${config.reasoning}`,
            `Transcript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted`,
            ``,
            `─── MODEL RESPONSE ───`,
            text,
            ``,
            `─── PARSED VERDICT ───`,
            JSON.stringify(verdict, null, 2),
            ``,
            `─── SCENARIO DETAILS ───`,
            JSON.stringify(details, null, 2),
          ]

          ctx.ui.setWidget('review-probe', output)
          ctx.ui.setStatus('review-probe', '')
          ctx.ui.notify(`Probe result: ${verdict['outcome'] ?? 'unknown'}`, 'info')
        } catch (err) {
          ctx.ui.setStatus('review-probe', '')
          ctx.ui.notify(`Probe failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
        return
      }

      ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: dry | call`, 'error')
    },
  })

  pi.registerTool({
    name: 'review_probe',
    label: 'Review Probe',
    description:
      'Test the pi-permission-auto-review classifier. Returns the prompt it would receive (dry) or calls the model and returns the verdict (call). Use to validate how additionalPolicy rules affect decisions.',
    promptSnippet: 'Probe the permission reviewer with dry or call mode',
    promptGuidelines: [
      'Use review_probe to test how the auto-review classifier would judge a permission request.',
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

      if (params.mode === 'dry') {
        return {
          content: [
            {
              type: 'text',
              text: `# Review Probe — DRY RUN\n\nConfig: provider=${config.provider} model=${config.model}\nBaseline: ${config.includeBaselinePolicy ? 'ON' : 'OFF'}\nAdditional policy: ${config.additionalPolicy ?? 'none'}\nTranscript: ${transcript.stats.transcriptEntriesRetained} retained, ${transcript.stats.transcriptEntriesOmitted} omitted\n\n## System Prompt (~${approximateTokens(systemPrompt)} tokens)\n\`\`\`\n${systemPrompt}\n\`\`\`\n\n## User Prompt (~${approximateTokens(userPrompt)} tokens)\n\`\`\`\n${userPrompt}\n\`\`\``,
            },
          ],
          details: { config, transcriptStats: transcript.stats, details },
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
            text: `# Review Probe — LIVE CALL\n\nConfig: provider=${config.provider} model=${config.model}\n\n## Verdict\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\`\n\n## Scenario\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``,
          },
        ],
        details: { verdict, scenario: details, transcriptStats: transcript.stats },
      }
    },
  })
}
