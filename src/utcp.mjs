// @ts-check
// UTCP manual (experimental): lets UTCP clients call this CLI directly, without an MCP server.
// Format per the UTCP CLI plugin docs: tools[].tool_call_template = { call_template_type: "cli", commands: [...] },
// arguments substituted via UTCP_ARG_<name>_UTCP_END. Not yet tested with a UTCP client.

import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/api-dead-ends.mjs', import.meta.url));
const arg = (/** @type {string} */ n) => `UTCP_ARG_${n}_UTCP_END`;

export function utcpManual() {
  const cmd = `node "${BIN}"`;
  const s = (/** @type {string} */ d) => ({ type: 'string', description: d });
  /** @param {string} name @param {string} description @param {Record<string, any>} props @param {string} command */
  const tool = (name, description, props, command) => ({
    name, description, tags: ['api', 'observability', 'openapi'],
    inputs: { type: 'object', properties: props, required: Object.keys(props) },
    outputs: { type: 'object' },
    tool_call_template: { name: `api_dead_ends_${name}`, call_template_type: 'cli', commands: [{ command, append_to_final_output: true }] },
  });
  return {
    utcp_version: '1.0.0',
    manual_version: '0.2.0',
    tools: [
      tool('detect_project', 'Read-only scan of a repository: services, languages, frameworks, specs, observability hints.', { path: s('Repository root') }, `${cmd} detect ${arg('path')}`),
      tool('setup_plan', 'Commands per service for a traffic source. Writes nothing.', { path: s('Repository root'), source: s('elasticsearch, datadog-apm, datadog, prometheus, loki, appinsights, cloudwatch, newrelic, dynatrace, splunk, accesslog, csv, none') },
        `cd ${arg('path')} && ${cmd} init --yes --json --dry-run --source ${arg('source')}`),
      tool('build_query', 'Print the aggregation query for a source; the human runs it.', { source: s('Source id'), service: s('Service name in the source'), days: s('Window in days') },
        `${cmd} query ${arg('source')} --service ${arg('service')} --days ${arg('days')}`),
      tool('spec_from_routes', 'Minimal OpenAPI JSON from a framework route list file.', { file: s('routes.txt or routes.json') }, `${cmd} spec from-routes ${arg('file')}`),
      tool('analyze_usage', 'Report as JSON: totals, server errors, shadow and not-seen endpoints.', { usage: s('Usage table CSV/JSON'), spec: s('OpenAPI JSON') },
        `${cmd} report --usage ${arg('usage')} --spec ${arg('spec')} --json`),
    ],
  };
}
