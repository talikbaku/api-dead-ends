# api-dead-ends report: Shop API (demo) · API version 1.4.2

## Summary

- **2 endpoints with server errors** (5xx ≥ 1% of calls and ≥ 10 responses) — **and 1,624 more 5xx on 3 endpoints below that threshold**.
- **2 recent spikes**: 5xx over the threshold in the last days, hidden by the period average.
- **1 endpoint with many client errors** (4xx other than 401/404 ≥ 10%).
- **3 undocumented endpoints** called (not in the spec).
- **3 endpoints not called** in 30 days, 2 rare, 2 deprecated but still called. Confidence: **low**.
- 4,210,931 requests in 30 method+path pairs, 2026-10-26 – 2026-11-24. Operations documented in the spec: 26 (undocumented ones are counted separately above).

> "Not called" means not seen in this window — not "dead". Monthly jobs, partners and old clients may call less often, and endpoints that do not log are invisible. Treat it as a recommendation to check, never as a reason to delete.

## Recent spikes

Over the threshold in a recent window, hidden by the average of the whole period. Look at what changed.

| Method | Path | Window | 5xx | Share | Whole period |
|---|---|---|---:|---:|---|
| GET | `/products/search` | last 3 days | 937 | 4.30% | 0.49% |
| POST | `/payments` | last 3 days | 189 | 2.57% | 0.28% |

## Server errors

Rule: 5xx ≥ 1% of calls **and** ≥ 10 responses (change with `--error-share`, `--error-min`).

| Method | Path | Calls | 5xx | Share | Statuses |
|---|---|---:|---:|---:|---|
| POST | `/promo/apply` | 24,541 | 5,751 | 23.43% | 200:18790 500:5751 |
| DELETE | `/orders/{id}` | 4,459 | 345 | 7.74% | 200:4114 500:345 |

## Other endpoints with 5xx (below the threshold)

| Method | Path | Calls | 5xx | Share |
|---|---|---:|---:|---:|
| GET | `/products/search` | 223,226 | 1,099 | 0.49% |
| POST | `/orders` | 80,385 | 313 | 0.39% |
| POST | `/payments` | 76,078 | 212 | 0.28% |

## Client errors (4xx ≥ 10%, without 401/404)

| Method | Path | Calls | 4xx | Share | Statuses |
|---|---|---:|---:|---:|---|
| PATCH | `/users/me` | 5,951 | 854 | 14.35% | 200:5097 400:854 |

## Undocumented: called, not in the spec

| Method | Path | Calls | Why | Statuses |
|---|---|---:|---|---|
| GET | `/api/v1/products/{id}/reviews` | 34,507 | path not in spec | 200:34507 |
| POST | `/api/v1/orders/{id}/retry` | 1,251 | path not in spec | 200:1251 |
| GET | `/api/v2/products` | 520 | path not in spec | 200:520 |

## Not called in 30 days

| Method | Path | Note |
|---|---|---|
| GET | `/admin/stats` |  |
| GET | `/export/orders.csv` | looks periodic (report/job/import): check before removing |
| POST | `/orders/{id}/repeat` |  |

## Deprecated but still called

| Method | Path | Calls | Last seen |
|---|---|---:|---|
| GET | `/legacy/catalog` | 6,826 | 2026-11-24 |
| GET | `/v0/products` | 1,351 | 2026-11-12 |

## Rare (< 100 calls)

| Method | Path | Calls | Last seen | Statuses |
|---|---|---:|---|---|
| GET | `/reports/monthly` | 4 | 2026-11-01 | 200:4 |
| DELETE | `/cart/items/{itemId}` | 53 | 2026-11-24 | 200:53 |

## Used

| Method | Path | Calls | 5xx | Statuses |
|---|---|---:|---:|---|
| GET | `/products` | 1,116,763 | 0 | 200:1116763 |
| GET | `/products/{id}` | 711,787 | 0 | 200:703765 404:8022 |
| GET | `/users/me` | 414,655 | 0 | 200:414655 |
| GET | `/cart` | 330,589 | 0 | 200:330589 |
| GET | `/categories` | 253,879 | 0 | 200:253879 |
| GET | `/products/search` | 223,226 | 1,099 | 200:222127 504:1099 |
| POST | `/auth/refresh` | 217,128 | 0 | 200:171466 401:45662 |
| GET | `/payments/{id}/status` | 170,876 | 0 | 200:170876 |
| POST | `/cart/items` | 141,185 | 0 | 200:140317 400:868 |
| GET | `/orders/{id}` | 140,150 | 0 | 200:139029 404:1121 |
| POST | `/auth/login` | 91,537 | 0 | 200:82216 401:8175 429:1146 |
| GET | `/orders` | 85,101 | 0 | 200:85101 |
| POST | `/orders` | 80,385 | 313 | 201:80072 500:313 |
| POST | `/payments` | 76,078 | 212 | 200:75866 502:212 |
| POST | `/promo/apply` | 24,541 | 5,751 | 200:18790 500:5751 |
| PATCH | `/users/me` | 5,951 | 0 | 200:5097 400:854 |
| DELETE | `/orders/{id}` | 4,459 | 345 | 200:4114 500:345 |
| POST | `/payments/{id}/refund` | 1,056 | 0 | 200:1056 |
| GET | `/promo/{code}` | 319 | 0 | 200:319 |

## Noise (set aside)

- **OPTIONS/HEAD (CORS preflight):** 1 pair, 75,367 requests. Top: OPTIONS `/api/v1/orders` (75,367)
- **scanners and infra paths:** 2 pairs, 1,158 requests. Top: GET `/wp-login.php` (847), GET `/.env` (311)
- **unknown path, only 404/405 (broken client URLs):** 1 pair, 229 requests. Top: GET `/api/v1/prodcuts` (229)
