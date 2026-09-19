/**
 * Review API shim — re-exports prompt/transcript/verdict logic.
 *
 * Currently inlined from @mzwing/pi-permission-auto-review because the package
 * does not yet export these internals. When https://github.com/mzwing/pi-packages/issues/14
 * is resolved, flip the import source below from "./inlined/*" to the package.
 *
 * TO SWITCH (after mzwing exports internals):
 *   1. Change each import below from './inlined/*.js' to '@mzwing/pi-permission-auto-review'
 *   2. Delete the inlined source files (transcript.ts, prompt.ts, policy.ts, verdict.ts)
 *   3. Remove this shim — import directly from @mzwing in index.ts
 */

export { renderTranscript, type RenderedTranscript, type TranscriptStats } from './transcript.js'
export { buildReviewPrompt, buildSystemPrompt, type ReviewPrompt, type PermissionDetails } from './prompt.js'
export { FIXED_REVIEW_PROTOCOL } from './policy.js'
export { parseReviewAssessment, type ReviewAssessment, type RiskLevel, type UserAuthorization } from './verdict.js'
