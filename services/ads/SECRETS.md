# levonis-ads — secrets

Names only. No value of any of these appears in this repository, in a var, in a
log line or in a delivery row, and `_deploy-worker.yml` (slice 1.9) uploads only
the names listed here, from repository secrets `ADS__<NAME>`.

**A provider is configured only when every one of its names below is present.**
When one is missing the adapter is not called at all: the registry substitutes
the SANDBOX implementation, which validates the mapping, makes **no** outbound
request and writes `ads_deliveries(status='sandbox')`. Unsetting a secret is
therefore the emergency kill switch of `01-TARGET.md` §9.1 — no deploy, no flag,
no code path that can leak while the credential is gone.

## Meta Conversions API (`meta_capi`)

- `META_CAPI_ACCESS_TOKEN` — system-user token for the graph/Marketing endpoint.
- `META_CAPI_DATASET_ID` — the dataset (pixel) the server events are posted to.

## Google Ads offline conversions (`google_ads`)

- `GOOGLE_ADS_DEVELOPER_TOKEN` — developer token of the manager account.
- `GOOGLE_ADS_ACCESS_TOKEN` — OAuth access token minted outside this Worker.
- `GOOGLE_ADS_CUSTOMER_ID` — the customer id the uploads are attributed to.
- `GOOGLE_ADS_CONVERSION_ACTION_ID` — the conversion action the uploads name.

## TikTok events (`tiktok`)

- `TIKTOK_ADS_ACCESS_TOKEN` — events API token.
- `TIKTOK_ADS_PIXEL_CODE` — the pixel the events belong to.

## Snapchat conversions (`snapchat`)

- `SNAPCHAT_ADS_ACCESS_TOKEN` — conversions API token.
- `SNAPCHAT_ADS_PIXEL_ID` — the pixel the events belong to.

## Platform

- `ADS_SIGNING_KEY` — base64url PKCS#8 Ed25519. This Worker's own key; it signs
  the hop envelope of any call it makes and, from Phase 2, its own events.
- `HEALTH_PROBE_TOKEN` — constant-time compared by `GET /health?deep=1`.
