// Synthetic polyglot repository for tests and demos. Everything here is made up.
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export const FILES = {
  'docker-compose.yml': 'services:\n  elasticsearch:\n    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0\n  kibana:\n    image: docker.elastic.co/kibana/kibana:8.15.0\n',
  'services/gateway/package.json': JSON.stringify({ name: '@shop/gateway', dependencies: { express: '^4.21.0', 'pino-http': '^10.0.0' } }, null, 2),
  'services/gateway/openapi.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'Gateway', version: '1' }, paths: {
    '/api/products': { get: { responses: {} } }, '/api/products/{id}': { get: { responses: {} } },
    '/api/cart': { get: { responses: {} }, post: { responses: {} } }, '/api/legacy/feed': { get: { deprecated: true, responses: {} } },
  } }, null, 2),
  'services/orders/go.mod': 'module github.com/shop/orders\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgo.uber.org/zap v1.27.0\n)\n',
  'services/orders/routes.txt': '[GIN-debug] GET    /orders                   --> main.list (3 handlers)\n[GIN-debug] POST   /orders                   --> main.create (3 handlers)\n[GIN-debug] GET    /orders/:id               --> main.get (3 handlers)\n[GIN-debug] DELETE /orders/:id               --> main.cancel (3 handlers)\n[GIN-debug] POST   /orders/:id/repeat        --> main.repeat (3 handlers)\n',
  'services/payments/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>payments</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>springdoc-openapi-starter-webmvc-ui</artifactId></dependency><dependency><artifactId>micrometer-registry-prometheus</artifactId></dependency><dependency><artifactId>logstash-logback-encoder</artifactId></dependency></dependencies></project>\n',
  'services/catalog/requirements.txt': 'fastapi==0.115.0\nuvicorn==0.30.0\nstructlog==24.4.0\nprometheus-fastapi-instrumentator==7.0.0\n',
  'services/accounts/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.2'\ngem 'lograge'\n",
  'services/accounts/routes.txt': '   Prefix Verb   URI Pattern                 Controller#Action\n    users GET    /users(.:format)            users#index\n          POST   /users(.:format)            users#create\n     user GET    /users/:id(.:format)        users#show\n          PATCH  /users/:id(.:format)        users#update\n          DELETE /users/:id(.:format)        users#destroy\n',
  'web/package.json': JSON.stringify({ name: 'shop-web', dependencies: { next: '15.0.0', react: '19.0.0' } }, null, 2),
};

/** Canned Elasticsearch response for the gateway (shape of `query elasticsearch`). */
export const ES_GATEWAY = { aggregations: { ep: { buckets: [
  { key: { method: 'GET', path: '/api/products' }, doc_count: 9000, status: { buckets: [{ key: 200, doc_count: 9000 }] } },
  { key: { method: 'GET', path: '/api/products/123' }, doc_count: 4000, status: { buckets: [{ key: 200, doc_count: 3700 }, { key: 500, doc_count: 300 }] } },
  { key: { method: 'GET', path: '/api/cart' }, doc_count: 2500, status: { buckets: [{ key: 200, doc_count: 2500 }] } },
  { key: { method: 'GET', path: '/api/legacy/feed' }, doc_count: 40, status: { buckets: [{ key: 200, doc_count: 40 }] } },
  { key: { method: 'GET', path: '/api/reviews/9' }, doc_count: 700, status: { buckets: [{ key: 200, doc_count: 700 }] } },
] } } };

/** @param {string} [dir] */
export function makeRepo(dir = mkdtempSync(join(tmpdir(), 'ade-repo-'))) {
  for (const [p, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}
