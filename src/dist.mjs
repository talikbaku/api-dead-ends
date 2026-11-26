// @ts-check
// How users get this package. Until it is on npm, every printed command and MCP config points at GitHub;
// flip ON_NPM in the release that is published to npm.
export const ON_NPM = true;
export const VERSION = '0.2.0';
/** Command prefix for printed instructions when the user ran us through npx. */
export const NPX = ON_NPM ? 'npx api-dead-ends' : 'npx github:talikbaku/api-dead-ends';
/** Pinned package spec for MCP configs (`npx -y <spec> mcp`). */
export const MCP_PKG = ON_NPM ? `api-dead-ends@${VERSION}` : `github:talikbaku/api-dead-ends#v${VERSION}`;
