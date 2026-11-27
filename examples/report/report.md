# api-dead-ends report: Shop API (demo) · API version 1.4.2

## Summary

- **2 endpoints with server errors** (5xx ≥ 1% of calls and ≥ 10 responses) — **and 1,624 more 5xx on 3 endpoints below that threshold**.
- **2 recent spikes**: 5xx over the threshold in the last days and ≥ 3× the days before.
- **1 endpoint with many client errors** (4xx other than 401/404 ≥ 10%).
- **3 undocumented endpoints** called (not in the spec).
- **3 endpoints not called** in 30 days, 2 rare, 2 deprecated but still called. Confidence: **low**.
- 4,210,931 requests in 30 method+path pairs, 2026-10-26 – 2026-11-24. Operations documented in the spec: 26 (undocumented ones are counted separately above).

> "Not called" means not seen in this window — not "dead". Monthly jobs, partners and old clients may call less often, and endpoints that do not log are invisible. Treat it as a recommendation to check, never as a reason to delete.

## Recent spikes

Over the threshold in a recent window and at least 3× the 5xx share of the days before it. Look at what changed.

| Method | Path | Window | 5xx | Share | Days before |
|---|---|---|---:|---:|---|
| GET | `/products/search` | last 3 days | 937 | 4.30% | 0.08% |
| POST | `/payments` | last 1 day | 65 | 2.43% | 0.20% |

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

## Per day: endpoints with 5xx

Calls and 5xx for each day (UTC), for every endpoint above. All endpoints: `perDay` in report.json.

### GET `/products/search`

| Date | Calls | 5xx |
|---|---:|---:|
| 2026-10-26 | 7,235 | 6 |
| 2026-10-27 | 8,466 | 7 |
| 2026-10-28 | 9,003 | 6 |
| 2026-10-29 | 8,405 | 6 |
| 2026-10-30 | 7,578 | 5 |
| 2026-10-31 | 6,023 | 6 |
| 2026-11-01 | 5,453 | 6 |
| 2026-11-02 | 7,878 | 5 |
| 2026-11-03 | 7,651 | 7 |
| 2026-11-04 | 8,342 | 7 |
| 2026-11-05 | 7,538 | 6 |
| 2026-11-06 | 8,320 | 6 |
| 2026-11-07 | 5,595 | 6 |
| 2026-11-08 | 5,628 | 6 |
| 2026-11-09 | 8,000 | 6 |
| 2026-11-10 | 8,979 | 6 |
| 2026-11-11 | 8,191 | 6 |
| 2026-11-12 | 8,291 | 6 |
| 2026-11-13 | 7,679 | 6 |
| 2026-11-14 | 5,463 | 6 |
| 2026-11-15 | 5,973 | 6 |
| 2026-11-16 | 7,549 | 6 |
| 2026-11-17 | 7,834 | 5 |
| 2026-11-18 | 7,834 | 5 |
| 2026-11-19 | 8,353 | 6 |
| 2026-11-20 | 8,164 | 6 |
| 2026-11-21 | 6,032 | 7 |
| 2026-11-22 | 6,169 | 690 |
| 2026-11-23 | 8,081 | 240 |
| 2026-11-24 | 7,519 | 7 |

### POST `/payments`

| Date | Calls | 5xx |
|---|---:|---:|
| 2026-10-26 | 2,856 | 1 |
| 2026-10-27 | 2,690 | 0 |
| 2026-10-28 | 2,424 | 1 |
| 2026-10-29 | 2,672 | 1 |
| 2026-10-30 | 2,433 | 0 |
| 2026-10-31 | 1,994 | 1 |
| 2026-11-01 | 1,714 | 1 |
| 2026-11-02 | 2,882 | 0 |
| 2026-11-03 | 2,888 | 0 |
| 2026-11-04 | 2,604 | 1 |
| 2026-11-05 | 2,645 | 1 |
| 2026-11-06 | 2,827 | 1 |
| 2026-11-07 | 2,071 | 0 |
| 2026-11-08 | 1,786 | 1 |
| 2026-11-09 | 3,004 | 2 |
| 2026-11-10 | 3,049 | 1 |
| 2026-11-11 | 2,535 | 1 |
| 2026-11-12 | 2,824 | 2 |
| 2026-11-13 | 3,041 | 1 |
| 2026-11-14 | 1,868 | 0 |
| 2026-11-15 | 2,111 | 1 |
| 2026-11-16 | 2,535 | 0 |
| 2026-11-17 | 2,986 | 0 |
| 2026-11-18 | 2,773 | 1 |
| 2026-11-19 | 2,815 | 2 |
| 2026-11-20 | 2,767 | 1 |
| 2026-11-21 | 1,936 | 2 |
| 2026-11-22 | 2,103 | 56 |
| 2026-11-23 | 2,569 | 68 |
| 2026-11-24 | 2,676 | 65 |

### POST `/promo/apply`

| Date | Calls | 5xx |
|---|---:|---:|
| 2026-10-26 | 922 | 272 |
| 2026-10-27 | 873 | 209 |
| 2026-10-28 | 801 | 167 |
| 2026-10-29 | 835 | 224 |
| 2026-10-30 | 837 | 216 |
| 2026-10-31 | 588 | 162 |
| 2026-11-01 | 599 | 92 |
| 2026-11-02 | 824 | 148 |
| 2026-11-03 | 996 | 304 |
| 2026-11-04 | 866 | 176 |
| 2026-11-05 | 986 | 266 |
| 2026-11-06 | 841 | 171 |
| 2026-11-07 | 580 | 141 |
| 2026-11-08 | 690 | 181 |
| 2026-11-09 | 965 | 274 |
| 2026-11-10 | 942 | 250 |
| 2026-11-11 | 845 | 162 |
| 2026-11-12 | 881 | 164 |
| 2026-11-13 | 999 | 175 |
| 2026-11-14 | 639 | 180 |
| 2026-11-15 | 605 | 179 |
| 2026-11-16 | 997 | 264 |
| 2026-11-17 | 832 | 151 |
| 2026-11-18 | 902 | 264 |
| 2026-11-19 | 878 | 249 |
| 2026-11-20 | 806 | 126 |
| 2026-11-21 | 648 | 137 |
| 2026-11-22 | 574 | 144 |
| 2026-11-23 | 981 | 178 |
| 2026-11-24 | 809 | 125 |

### DELETE `/orders/{id}`

| Date | Calls | 5xx |
|---|---:|---:|
| 2026-10-26 | 165 | 16 |
| 2026-10-27 | 171 | 15 |
| 2026-10-28 | 167 | 16 |
| 2026-10-29 | 164 | 16 |
| 2026-10-30 | 155 | 14 |
| 2026-10-31 | 107 | 8 |
| 2026-11-01 | 125 | 7 |
| 2026-11-02 | 144 | 12 |
| 2026-11-03 | 157 | 12 |
| 2026-11-04 | 156 | 12 |
| 2026-11-05 | 178 | 10 |
| 2026-11-06 | 168 | 13 |
| 2026-11-07 | 116 | 11 |
| 2026-11-08 | 99 | 5 |
| 2026-11-09 | 176 | 8 |
| 2026-11-10 | 161 | 8 |
| 2026-11-11 | 165 | 8 |
| 2026-11-12 | 173 | 11 |
| 2026-11-13 | 169 | 14 |
| 2026-11-14 | 115 | 9 |
| 2026-11-15 | 114 | 8 |
| 2026-11-16 | 157 | 12 |
| 2026-11-17 | 146 | 12 |
| 2026-11-18 | 152 | 15 |
| 2026-11-19 | 157 | 12 |
| 2026-11-20 | 166 | 16 |
| 2026-11-21 | 117 | 8 |
| 2026-11-22 | 112 | 11 |
| 2026-11-23 | 147 | 10 |
| 2026-11-24 | 160 | 16 |

### POST `/orders`

| Date | Calls | 5xx |
|---|---:|---:|
| 2026-10-26 | 3,004 | 8 |
| 2026-10-27 | 3,063 | 15 |
| 2026-10-28 | 2,814 | 9 |
| 2026-10-29 | 3,099 | 12 |
| 2026-10-30 | 2,648 | 7 |
| 2026-10-31 | 2,163 | 8 |
| 2026-11-01 | 2,210 | 11 |
| 2026-11-02 | 2,895 | 15 |
| 2026-11-03 | 2,674 | 8 |
| 2026-11-04 | 2,936 | 13 |
| 2026-11-05 | 2,696 | 13 |
| 2026-11-06 | 2,720 | 8 |
| 2026-11-07 | 2,108 | 9 |
| 2026-11-08 | 2,057 | 7 |
| 2026-11-09 | 3,194 | 13 |
| 2026-11-10 | 3,071 | 8 |
| 2026-11-11 | 3,218 | 14 |
| 2026-11-12 | 2,750 | 8 |
| 2026-11-13 | 2,779 | 13 |
| 2026-11-14 | 2,157 | 7 |
| 2026-11-15 | 2,207 | 9 |
| 2026-11-16 | 2,679 | 12 |
| 2026-11-17 | 2,905 | 9 |
| 2026-11-18 | 3,145 | 9 |
| 2026-11-19 | 2,647 | 14 |
| 2026-11-20 | 2,699 | 11 |
| 2026-11-21 | 2,034 | 9 |
| 2026-11-22 | 2,022 | 9 |
| 2026-11-23 | 2,662 | 14 |
| 2026-11-24 | 3,129 | 11 |

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
