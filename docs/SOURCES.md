# Sources

Back to [README](../README.md). Every source works the same way: `query <source>` prints a query, you run it with your own access and save the response, `convert <source> <file>` turns it into a usage table.


| Source | Command | History it usually keeps | Verified |
|---|---|---|---|
| Elasticsearch / OpenSearch / Kibana | `query elasticsearch`, `fetch elasticsearch` | log retention (often 7–30 days) | ✅ real data |
| Datadog APM metrics | `query datadog-apm` | ~15 months — best for "not seen" | docs only |
| Datadog Logs / Spans | `query datadog` | ~15 days | docs only |
| Prometheus, Thanos, Mimir, VictoriaMetrics | `query prometheus --preset …` | 15 days to months | docs only |
| Grafana Loki | `query loki` | log retention | docs only |
| VictoriaLogs (LogsQL) | `query victorialogs` | log retention | docs only |
| Azure Application Insights / API Management | `query appinsights`, `query azure-apim` | 90 days by default | docs only |
| AWS CloudWatch Logs Insights / Athena (ALB logs) | `query cloudwatch`, `query athena` | as configured | docs only |
| GCP BigQuery (load balancer logs) | `query bigquery` | as configured | docs only |
| New Relic / Dynatrace / Splunk | `query newrelic`, `query dynatrace`, `query splunk` | varies | docs only |
| nginx / Apache / JSON access logs (`.gz` ok) | `convert accesslog <files…>` | whatever files you have | synthetic |
| Any CSV export | `convert csv --map …` | any | synthetic |

Prometheus presets (`--preset`, `init` picks one from your stack):

| Your stack | Preset |
|---|---|
| Spring Boot / Micrometer | `spring` |
| OpenTelemetry (new / pre-1.20 semconv), spanmetrics connector | `otel`, `otel-old`, `spanmetrics` |
| ASP.NET Core prometheus-net | `prometheus-net` |
| Go promhttp | `go-promhttp` |
| Node express-prom-bundle | `express` |
| prometheus-fastapi-instrumentator | `fastapi` |
| ingress-nginx, Traefik (service level only) | `nginx-ingress`, `traefik` |
| anything else | `generic` + `--method-field --path-field --status-field` |

Sources without first/last seen dates (Loki instant queries, Kibana responses without date aggregations): pass `--days N` to `report`.

