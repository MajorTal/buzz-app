# Link Lab

First visual experiment for link rendering, activated as a page plugin in the
isolated `/tests/fixtures/link-lab.html` preview. Add `?theme=dark` for dark mode.
Uses the design system's blue 11 text, blue 4 hover fill and Tabler icons.
Links are transparent by default. Padding stays 2px on every side, including
wrapped line fragments, with -2px inline margins so it adds no horizontal gap
to surrounding text. Hovering does not move the surrounding text.
Hover backgrounds have 4px corners. GitHub, Google Drive, Figma, Notion, Slack,
Dropbox, OneDrive, GitLab, YouTube, Loom, Zoom and Teams use their service icons.
Google Docs, Sheets and Slides use document, spreadsheet and presentation icons.
Other websites use a globe. Icons use the same blue foreground and do not fetch
favicons, titles or remote metadata.

Recognition uses host boundaries and known short-link domains. OneDrive also
recognizes Microsoft's documented
[`<tenant>-my.sharepoint.com` hosts](https://learn.microsoft.com/en-us/sharepoint/list-onedrive-urls).
Unknown or self-hosted service domains retain the globe icon.

Sample activation stays in the preview. The separate bundled `buzz.links` plugin
now applies the same component and CSS to HTTPS and supported Buzz links in messages.
Buzz channel, message and thread links have distinct icons and use known channel
names from the current community. Generic labels remain when names are unavailable.
Hover or keyboard focus opens a clickable message preview with author and timestamp on one
row beside the author's avatar, the channel below, and an excerpt clamped to four
lines, ending early before a blank paragraph. The card opens the same destination
with pointer or keyboard activation. Recency follows Buzz desktop's thread-summary ladder: just now, minutes,
hours under 24 hours, days under seven days, then a short date. Hovering the time
shows its full date and time. Hidden channels and
DMs use a lock; other known channels use a hash. This creates a disposable, bounded session thread reader only while open;
it does not mark messages read. Other-community previews do not connect or switch
communities on hover. Mentions with signed recipient IDs and unambiguous loaded
names share the hover styling; known local agent identities use a robot icon.
Known channel names in `#channel` text open through the same host link path.
Both legacy channel/message links and versioned `buzz://open` links are supported.
The host opens them through scoped navigation; message links reveal the selected
message in its verified thread after bounded history loading. Missing targets
report navigation failure. The lab only previews their appearance.
It uses `registerLink`, leaving the existing inline-text contract unchanged.
The lab remains separate from the default catalog. No relay reads, signing, or
persistence are involved in the preview.

`/tests/fixtures/link-messages.html` exercises real message rows, plugin removal,
failed rendering, labeled Markdown links, clickable previews, and plain fallback.
`tests/browser/buzz-links.spec.mjs` covers scoped navigation and card activation in
Chromium and WebKit. Run the contribution workflow's full batch scan before integration.
