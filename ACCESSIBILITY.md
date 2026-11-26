# Accessibility

api-dead-ends should be usable by everyone, including people who use screen readers, magnifiers, high contrast, or only a keyboard. This file says what works today, what does not yet, and how to tell me about a barrier.

## Supported environments

| Part | What to expect |
|---|---|
| Command line | Works in any terminal and with terminal screen readers (VoiceOver, NVDA, Orca). Commands have `--help`. Errors are short plain sentences and usually say where to look next. |
| Terminal output | Plain text with symbols *and* words for each finding (for example "✖ Server errors"), so meaning never depends on colour alone. Colour only when the output goes to an interactive terminal; set `NO_COLOR=1` to turn it off. |
| `report.md` | Plain Markdown with headings and tables: works with screen readers in any Markdown viewer, editor or GitHub. **The most accessible format** — use it if the HTML report gives you trouble. |
| `report.html` | Self-contained page with `lang="en"`, native `<button>` controls for tabs and the day-window selector (keyboard reachable), light and dark themes that follow your system setting. |
| README images | Terminal and Claude Code screenshots have text alternatives (`alt`) that describe what they show. |
| Documentation | Markdown on GitHub, with headings, lists and tables; code blocks for commands. |

## Known limitations

- `report.html`: tabs do not yet use the ARIA tab pattern (`role="tab"`, `aria-selected`), so screen readers announce them as plain buttons; there is no visible custom focus style beyond the browser default; tables have no `<caption>`. Not yet tested with a screen reader.
- `report.html`: the Overview tiles and the "Look at first" rows react to mouse clicks only and cannot be reached with the keyboard; use the tab buttons, which open the same views. After you choose a tab or a time window the page is redrawn and keyboard focus moves back to the top of the page.
- The per-day sparklines in `report.html` (the "Per day" column) are SVG drawings with no text alternative, and the per-day numbers they show are not in `report.md` or `report.json` yet. Totals per endpoint are in all three formats.
- Colour contrast of the HTML report and the README images has not been measured against WCAG 2.2 AA. The report uses red/amber on counts and badges, always together with the number.
- Terminal symbols (✖ ▲ ○) are read by some screen readers as their Unicode names; the words next to them carry the meaning.

## Report a barrier

Open an [accessibility issue](https://github.com/talikbaku/api-dead-ends/issues/new?template=accessibility.yml) and say what you tried, your setup (assistive technology, browser, OS) and where it failed. If the form is hard to use, open a regular issue and write the same details in plain text — a report does not need to be polished. Accessibility bugs are treated like any other bug and get priority over new features.

Last reviewed: 2026-11-26.
