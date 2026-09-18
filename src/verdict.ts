/**
 * Verdict parsing — same logic as pi-permission-auto-review's verdict.ts.
 *
 * Parses the JSON response from the reviewer model into a typed assessment.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type UserAuthorization = 'unknown' | 'low' | 'medium' | 'high'

export interface ReviewAssessment {
  riskLevel: RiskLevel
  userAuthorization: UserAuthorization
  outcome: 'allow' | 'deny'
  rationale: string
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function parseJsonObject(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) {
      throw new Error('review response was not valid JSON')
    }
    return JSON.parse(text.slice(start, end + 1)) as JsonValue
  }
}

export function parseReviewAssessment(text: string): ReviewAssessment {
  const raw = parseJsonObject(text) as Record<string, JsonValue>

  if (raw['outcome'] !== 'allow' && raw['outcome'] !== 'deny') {
    throw new Error(`invalid outcome: ${String(raw['outcome'])}`)
  }

  const outcome = raw['outcome'] as 'allow' | 'deny'
  const riskLevel = (raw['risk_level'] as RiskLevel | undefined) ?? (outcome === 'allow' ? 'low' : 'high')
  const userAuthorization = (raw['user_authorization'] as UserAuthorization | undefined) ?? 'unknown'
  const rationale =
    typeof raw['rationale'] === 'string' && raw['rationale'].trim().length > 0
      ? raw['rationale'].trim()
      : outcome === 'allow'
        ? 'Automatic review returned a low-risk allow decision.'
        : 'The review returned no rationale.'

  return { riskLevel, userAuthorization, outcome, rationale }
}
