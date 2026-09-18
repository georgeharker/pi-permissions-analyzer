# @geohar/review-probe

Pi extension: probe tester for `pi-permission-auto-review`.

## Build

```bash
npm run build       # tsup → dist/index.js (ESM) + dist/index.d.ts
npm run typecheck   # tsc --noEmit
npm run test        # vitest
```

## Structure

- `src/index.ts` — extension entry: `/review-probe` command + `review_probe` tool
- `src/transcript.ts` — session → JSONL transcript rendering (inlined from pi-permission-auto-review)
- `src/prompt.ts` — prompt construction (system policy + user evidence + permission request)
- `src/policy.ts` — fixed review protocol text
- `src/config.ts` — auto-review config loading (reads pi-permission-auto-review's config)
- `src/verdict.ts` — model response → ReviewAssessment parser
