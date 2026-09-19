import { describe, expect, it } from 'vitest'
import { parseReviewAssessment } from '../src/review-api.js'

describe('parseReviewAssessment', () => {
  it('accepts the compact Codex allow response', () => {
    expect(parseReviewAssessment('{"outcome":"allow"}')).toEqual({
      riskLevel: 'low',
      userAuthorization: 'unknown',
      outcome: 'allow',
      rationale: 'Automatic review returned a low-risk allow decision.',
    })
  })

  it('accepts a full deny response', () => {
    expect(
      parseReviewAssessment(
        '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}',
      ),
    ).toEqual({
      riskLevel: 'high',
      userAuthorization: 'unknown',
      outcome: 'deny',
      rationale: 'Publishing was not authorized.',
    })
  })

  it('extracts JSON from surrounding model text', () => {
    expect(
      parseReviewAssessment(
        'Result:\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"The target is not authorized."}\n',
      ),
    ).toMatchObject({
      riskLevel: 'high',
      userAuthorization: 'low',
      outcome: 'deny',
    })
  })

  it('rejects invalid JSON', () => {
    expect(() => parseReviewAssessment('not json')).toThrow()
  })
})
