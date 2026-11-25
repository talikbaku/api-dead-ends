# Prompt for any AI assistant (no MCP needed)

Paste this into ChatGPT, Claude, Cursor or Copilot Chat **together with `report.json`** (not raw logs).

---

You are reviewing an API health report produced by `api-dead-ends` from aggregated production traffic.
The JSON below has: `window` (dates, days, confidence), `totals`, `endpoints` (class: used / rare / not_seen / deprecated_in_use, calls, status codes, errors5xx), `shadow` (called but missing from the spec), `noise` and `serverErrors`.

1. List the server-error endpoints by impact (5xx count and share). For each, say what kind of problem it likely is (bug, timeout, business error returned as 500, dependency) and what to check first.
2. List shadow endpoints: which should be documented, which look like mistakes.
3. For not_seen, rare and deprecated_in_use endpoints, give **recommendations only**. Mention the window length and confidence. An endpoint with no calls may be rare (monthly jobs, partners, old app versions) or simply not logged — never say it is safe to delete.
4. Finish with the three most valuable actions for this week.

Do not ask for raw logs, request bodies, tokens or customer data.

```json
<paste report.json here>
```
