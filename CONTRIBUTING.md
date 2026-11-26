# Contributing to api-dead-ends

Thanks for helping! api-dead-ends is a CLI, an MCP server and a Claude Code plugin that compare your OpenAPI spec with real traffic. It is maintained by one person in spare time, so small, focused changes are the easiest to review.

## Most useful right now

- **Run it on your traffic and tell me what broke** — wrong numbers, a source that did not parse (Kibana / Elasticsearch, VictoriaLogs, Datadog, Prometheus, access logs, CSV…), confusing output. [Open an issue](https://github.com/talikbaku/api-dead-ends/issues/new/choose).
- Accessibility problems in the output — see [ACCESSIBILITY.md](ACCESSIBILITY.md).
- Docs: anything you had to figure out yourself.

## Data rules

Never paste raw logs, tokens, IPs, hostnames or customer data. Use synthetic data (see `examples/`) or an aggregated usage table with paths you are allowed to share. Issues and pull requests are public.

## Development

- Setup: `git clone` the repo, then `npm test`. There is nothing to install: no runtime dependencies.
- Node.js 20+ (22 or 24 recommended). Zero runtime dependencies — please keep it that way; ask in an issue first if you think one is needed.
- ESM, `// @ts-check` with JSDoc types, tests with the built-in `node --test`.
- Run the tests: `npm test`. CI runs them on Node 20, 22 and 24.
- Values from traffic (paths, methods, statuses) are **untrusted**: they must never reach code, shell commands, Markdown or HTML unescaped. See [SECURITY.md](docs/SECURITY.md).

## Pull requests

Not sure if your idea fits? Open an issue and ask — questions are welcome.

1. For anything bigger than a small fix, open an issue first so we agree on the approach.
2. One change per pull request, with a test for new behaviour or a fixed bug.
3. Update README / docs / CHANGELOG.md when behaviour or flags change.
4. Keep examples and fixtures synthetic.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
