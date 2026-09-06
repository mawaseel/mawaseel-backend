# Mawaseel Admin API — V4 Commission

Backend for the Mawaseel 50/20 commission and customer ownership system.

## What it enforces
- A customer phone belongs to exactly one marketer (`customers/{sha256(phone)}`).
- First order: 50% of the profit attributed to that customer's order.
- Later orders: 20% investment commission.
- Trial-period orders: 0% commission.
- Hidden customer phone numbers remain in the admin-only `customers` collection and are not copied into partner-readable orders.
- Admin creation/deletion, verification, and marketer approval from V3 remain supported.

## Required Render environment variables
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PRIMARY_ADMIN_EMAIL`
- `ALLOWED_ORIGINS` (include `https://mawaseel.github.io` while using GitHub Pages)

## Main API routes
- `GET /health`
- `POST /api/orders/first`
- `GET /api/customers/lookup?phone=...`
- `POST /api/orders/investment`
- `PATCH /api/orders/:id`
- `DELETE /api/orders/:id`
- `POST /api/maintenance/migrate-legacy-orders` (PRIMARY only)
- Existing admin/verification/approval routes are retained.

Never commit `.env` or a Firebase service-account JSON file to GitHub.
