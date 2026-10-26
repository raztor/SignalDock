# Shared backend infrastructure

`http/configure-http.ts` centralizes structured errors and response-cache policy. Reusable HTTP concerns belong here; radio/user/provider business rules belong to their domain module or extension SDK.
