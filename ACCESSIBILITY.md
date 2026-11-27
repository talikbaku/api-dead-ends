# Accessibility

api-dead-ends should be usable by everyone, including people who use screen readers, magnifiers, high contrast, or only a keyboard. This file says what works today, what does not yet, and how to tell me about a barrier.

## Supported environments

| Part | What to expect |
|---|---|
| Command line | Works in any terminal and with terminal screen readers (VoiceOver, NVDA, Orca). Commands have `--help`. Errors are short plain sentences and usually say where to look next. |
| Terminal output | Plain text with symbols *and* words for each finding (for example "✖ Server errors"), so meaning never depends on colour alone. Colour only when the output goes to an interactive terminal; set `NO_COLOR=1` to turn it off. Every symbol comes with a word that says the same thing; the full list is below. |
| `report.md` | Plain Markdown with headings and tables: works with screen readers in any Markdown viewer, editor or GitHub. **The most accessible format** — use it if the HTML report gives you trouble. With per-day data it has a "Per day" table (date, calls, 5xx) for each endpoint with server errors or a recent spike. |
| `report.json` | Machine-readable. With per-day data, `perDay` holds calls and 5xx for every endpoint and every day — the numbers behind all sparklines. |
| `report.html` | Self-contained page, `lang="en"`, light and dark themes that follow your system setting. Text colours meet WCAG 2.2 AA contrast (4.5:1) in both themes; a test keeps it that way. Keyboard: every control is a native button with a visible focus outline; the sections follow the WAI-ARIA tabs pattern (`Tab` reaches the selected tab, `←` `→` `Home` `End` switch, the panel is labelled by its tab); the time window buttons say which one is pressed; focus stays where it was after the page redraws. Tables have header cells and captions; per-day sparklines have a short text alternative (total, peak day, the selected window), and the day-by-day numbers are in `report.md` and `report.json`. Meaning is never in colour alone: red and amber always come with a number or a word, and the 5xx share says "over threshold" or "below threshold". Font sizes are in `rem`, so the page follows the browser's font size setting. In Windows High Contrast (forced colours) the selected tab and time window get an outline, badges a border, and sparkline days outside the window are drawn in the system grey. |
| README images | Terminal and Claude Code screenshots have text alternatives (`alt`) that describe what they show. |
| Documentation | Markdown on GitHub, with headings, lists and tables; code blocks for commands. |

## Known limitations

- Not yet tested with a real screen reader (VoiceOver, NVDA, JAWS). `report.html` is checked with automated tools only: axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA rules plus best practices) on every tab in light and dark mode, and a keyboard-only run in Chromium (Playwright). Automated tools find only part of real barriers.
- Contrast is measured for the HTML report's text colours, not for the README images (terminal and Claude Code screenshots).
- Terminal symbols are read by some screen readers as their Unicode names (or skipped); the words next to them carry the meaning.
- `report.md` has the per-day table only for endpoints with 5xx or a recent spike (at most 20); the other per-day series are in `report.json`.
- The forced-colours styles are checked by a static test and in Chromium's forced-colours emulation, not yet in a real Windows High Contrast session.

## Terminal symbols

Each symbol is decoration next to a word; nothing is said by the symbol alone.

| Symbol | Where | Always comes with |
|---|---|---|
| `Δ` | `report` summary, with hourly data | "Today vs the same hours before: requests …, 5xx …" |
| `▲` | `report` summary | "Recent spikes: N" |
| `✖` | `report` summary | "Server errors: N" |
| `!` | `report` summary; `init` warnings | "Undocumented (called, not in spec): N"; a warning sentence (for example `! <source> not found in <services> manifests — continuing as asked`) |
| `○` | `report` summary | "Not called in N days: N (a hint, not a verdict)" |
| `↓` | `report` summary | "Deprecated but still called: N" |
| `×` | `report` summary and reports | a count and a status class, as in "12 × 5xx" |
| `…` | `report` summary | "N more in report.md" |
| `→` | after a file is written; `logging-probe send` progress lines | the file path, as in "→ report/report.md"; in `logging-probe send` the status code or error, as in "→ 200 (15 ms)" or "→ ECONNREFUSED" |
| `✓` | `init` source list | "verified" |
| `←` | `init` source list | "suggested" |
| `⚠` | `report.md` (not the terminal), Undocumented table | "debug/admin path answering 2xx — check auth" |

Other non-ASCII characters in the output are ordinary punctuation or maths inside sentences and carry no meaning of their own: `·` and `—` separate parts of a line, `–` joins a date range, `≥` and `≤` mean "at least" and "at most" (as in "5xx ≥ 1% of calls").

## Report a barrier

Open an [accessibility issue](https://github.com/talikbaku/api-dead-ends/issues/new?template=accessibility.yml) and say what you tried, your setup (assistive technology, browser, OS) and where it failed. If the form is hard to use, open a regular issue and write the same details in plain text — a report does not need to be polished. Accessibility bugs are treated like any other bug and get priority over new features.

Last reviewed: 2026-11-27 (report.html: axe-core 4.14, 0 violations on all tabs, light and dark).
