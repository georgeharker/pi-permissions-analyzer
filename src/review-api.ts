/**
 * Review API — imports from @mzwing/pi-permission-auto-review/review.
 *
 * Mzwing exported the internals as of v0.4.0 (see mzwing/pi-packages#14).
 * No more inlined copies — we use the exact same logic the live reviewer uses.
 */

export {
  renderTranscript,
  buildReviewPrompt,
  buildSystemPrompt,
  parseReviewAssessment,
  FIXED_REVIEW_PROTOCOL,
  type AutoReviewConfig,
  type RenderedTranscript,
  type ReviewPrompt,
  type ReviewAssessment,
} from '@mzwing/pi-permission-auto-review/review'

// The permission details type lives in pi-permission-system
export type { PromptPermissionDetails as PermissionDetails } from '@gotgenes/pi-permission-system'
