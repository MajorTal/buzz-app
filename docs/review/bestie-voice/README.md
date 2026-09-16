# Bestie voice review screenshots

Captured from the real Bestie components in Chromium using isolated identities, synthetic audio, and fixture transcript text. These are UI states, not recordings of a live model conversation.

## idle

![idle](idle.png)

## settings

![settings](settings.png)

## connecting

![connecting](connecting.png)

## listening

![listening](listening.png)

## speaking

![speaking](speaking.png)

## muted

![muted](muted.png)

## transcript

![transcript](transcript.png)

## transcript-dark

![transcript-dark](transcript-dark.png)

## transcript-compact

![transcript-compact](transcript-compact.png)

Reproduce with:

```sh
BESTIE_REVIEW_SCREENSHOTS=1 bin/pnpm exec playwright test --config tests/browser/playwright.config.mjs bestie.spec.mjs --project chromium --project webkit --no-deps
```

Captures are written under `test-results/browser/`.
