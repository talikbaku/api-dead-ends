# Accessibility

api-dead-ends should be usable by everyone, including people who use screen readers, magnifiers, high contrast, or only a keyboard. This file says what works today, what does not yet, and how to tell me about a barrier.

## Supported environments

| Part | What to expect |
|---|---|
| Command line | Works in any terminal and with terminal screen readers (VoiceOver, NVDA, Orca). Commands have `--help`. Errors are short plain sentences and usually say where to look next. |
| Terminal output | Plain text with symbols *and* words for each finding (for example "✖ Server errors"), so meaning never depends on colour alone. Colour only when the output goes to an interactive terminal; set `NO_COLOR=1` to turn it off. |
| `report.md` | Plain Markdown with headings and tables: works with screen readers in any Markdown viewer, editor or GitHub. **The most accessible format** — use it if the HTML report gives you trouble. |
| `report.html` | Self-contained page, `lang="en"`, light and dark themes that follow your system setting. Text colours meet WCAG 2.2 AA contrast (4.5:1) in both themes; a test keeps it that way. Keyboard: every control is a native button with a visible focus outline; the sections follow the WAI-ARIA tabs pattern (`Tab` reaches the selected tab, `←` `→` `Home` `End` switch, the panel is labelled by its tab); the time window buttons say which one is pressed; focus stays where it was after the page redraws. Tables have header cells and captions; per-day sparklines have a text alternative with the numbers. Meaning is never in colour alone: red and amber always come with a number or a word. |
| README images | Terminal and Claude Code screenshots have text alternatives (`alt`) that describe what they show. |
| Documentation | Markdown on GitHub, with headings, lists and tables; code blocks for commands. |

## Known limitations

- Not yet tested with a real screen reader (VoiceOver, NVDA, JAWS). `report.html` is checked with automated tools only: axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA rules plus best practices) on every tab in light and dark mode, and a keyboard-only run in Chromium (Playwright). Automated tools find only part of real barriers.
- Contrast is measured for the HTML report's text colours, not for the README images (terminal and Claude Code screenshots).
- The per-day numbers behind the sparklines are in the HTML report (as the sparkline's text alternative) but not yet in `report.md` or `report.json`. Totals per endpoint are in all three formats.
- Terminal symbols (✖ ▲ ○) are read by some screen readers as their Unicode names; the words next to them carry the meaning.

## Report a barrier

Open an [accessibility issue](https://github.com/talikbaku/api-dead-ends/issues/new?template=accessibility.yml) and say what you tried, your setup (assistive technology, browser, OS) and where it failed. If the form is hard to use, open a regular issue and write the same details in plain text — a report does not need to be polished. Accessibility bugs are treated like any other bug and get priority over new features.

Last reviewed: 2026-11-26 (report.html: axe-core 4.14, 0 violations on all tabs, light and dark).
