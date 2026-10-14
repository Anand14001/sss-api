# Salem Star Speaker — Backend API Documentation

Production-grade, secure, lightweight backend API for **Salem Star Speaker — The Speaking Contest**.

Built with **Node.js LTS, Express, Prisma ORM, and PostgreSQL**, integrated with **Razorpay** payment gateway and **cPanel authenticated SMTP** for automated confirmation emails.

---

## 1. Architecture and Technology Stack

- **Runtime & Web Framework:** Node.js (v18+ / v20+ / v22+ LTS) with Express.
- **Database & ORM:** PostgreSQL managed via **Prisma ORM** (`@prisma/client` and `prisma` CLI).
- **Payment Gateway:** Official **Razorpay Node SDK** (`razorpay`) with server-side order generation and dual signature verification (HMAC-SHA256 for checkout callbacks and webhook events).
- **Email Delivery:** Authenticated cPanel SMTP using **Nodemailer**, with delivery attempt tracking in the database and duplicate prevention.
- **Security Baseline:** Helmet HTTP security headers, CORS origin allowlisting, Express rate limiting, parameterized queries, and strict server-side validation.

---

## 2. Event and Category Pricing Rules

Authoritative server-side event rules:
- **Event:** Salem Star Speaker — The Speaking Contest
- **Date:** Sunday, 1 November 2026
- **Registration Deadline:** 26 October 2026, 23:59:59 IST
- **Venue:** Hotel A Square Rivera, Salem
- **Organisers:** Salem Parenting Club and Speak Up Salem Toastmasters Club
- **Contacts:** Vivek (86107 11306) and Tharu (7010713565)

### Authoritative Category Matrix

| Slug | Category | Eligible Age on 1 Nov 2026 | Fee (Rupees) | Fee (Paise) |
|---|---|---|---:|---:|
| `kid` | Junior (10–13 years) | 10 to 13 inclusive | ₹99 | 9,900 |
| `teen` | Teens (14–17 years) | 14 to 17 inclusive | ₹199 | 19,900 |
| `adult` | Adults (18+) | 18+ (up to 99) | ₹299 | 29,900 |

*Note: The fee is calculated on the server from the validated date of birth and category. Client-supplied amounts are ignored.*

---

## 3. Environment Variables

Create `.env` in `sss-api/` (never commit this file to git). Use `.env.example` as a template:

```env
# Server
NODE_ENV=production
PORT=4000

# PostgreSQL via Prisma ORM
DATABASE_URL="postgres://user:password@host:5432/dbname?sslmode=require"

# Razorpay Credentials (from Razorpay Dashboard -> Settings -> API Keys)
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# cPanel Authenticated SMTP Email (cPanel -> Email Accounts -> Connect Devices)
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=contact@yourdomain.com
SMTP_PASS=your_cpanel_mailbox_password
MAIL_FROM_NAME="Salem Star Speaker"
MAIL_FROM_ADDRESS=contact@yourdomain.com
MAIL_REPLY_TO=vivek@yourdomain.com

# Allowed CORS Origins (comma-separated list of frontends)
ALLOWED_ORIGINS=https://salemstarspeaker.com,https://www.salemstarspeaker.com,http://localhost:5173
```

---

## 4. Database Setup & Prisma Migrations

Prisma manages the schema in `prisma/schema.prisma`.

### Synchronizing Schema to PostgreSQL
To push schema changes to the PostgreSQL database:
```bash
npx prisma db push
```

### Seeding Event & Categories
To seed the database with initial event details and categories:
```bash
node prisma/seed.js
```
or run both together:
```bash
npm run migrate
```

### Schema Entities

1. **`event_config`**: Single row containing event date, deadline, venue, and registration status.
2. **`categories`**: Slugs (`kid`, `teen`, `adult`), labels, age limits, and fees in paise.
3. **`registrations`**: Participant details, unique reference (e.g. `SSS-2026-X8K2M9`), status (`AWAITING_PAYMENT`, `PAID`, `FAILED`), timestamps.
4. **`payments`**: Linked to registration; stores `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`, verification status, and failure reasons.
5. **`email_deliveries`**: Delivery log of confirmation emails, preventing duplicates and recording delivery outcomes.

---

## 5. Local Development & Running Tests

### Install dependencies
```bash
cd sss-api
npm install
```

### Generate Prisma Client
```bash
npx prisma generate
```

### Run Automated Tests
```bash
npm test
```
The test suite uses Node's native test runner (`node --test`) and executes:
- Input sanitization and phone number normalization
- Age calculation and category boundary checks (on 1 Nov 2026)
- Fee enforcement (₹99 for kids, ₹199 for teens, ₹299 for adults)
- Registration deadline enforcement
- Razorpay order creation and duplicate prevention
- Checkout signature verification (HMAC-SHA256)
- Webhook signature verification against raw request body
- Webhook idempotency (duplicate webhooks do not duplicate emails or state)
- Status check endpoint and payment retry functionality

### Start Development Server
```bash
npm run dev
```

---

## 6. API Reference (`/api/v1`)

### `GET /api/v1/health`
Health & readiness check. Returns `{ status: "ok", service: "sss-api", database: "healthy" }`.

### `GET /api/v1/event`
Public event configuration, categories, and fees for frontend hydration.

### `POST /api/v1/registrations`
Creates a pending registration and matching Razorpay order.
**Request Body:**
```json
{
  "fullName": "Aarav Sharma",
  "email": "aarav@example.com",
  "phone": "9876543210",
  "dob": "2014-06-15",
  "category": "kid",
  "occupation": "Student",
  "city": "Salem",
  "guardianName": "Sharma",
  "guardianPhone": "9876543211"
}
```
**Response (201 Created):**
```json
{
  "success": true,
  "registration": {
    "reference": "SSS-2026-X8K2M9",
    "fullName": "Aarav Sharma",
    "category": "kid",
    "amountRupees": 99,
    "amountPaise": 9900,
    "status": "AWAITING_PAYMENT"
  },
  "order": {
    "id": "order_xxxx",
    "amount": 9900,
    "currency": "INR",
    "keyId": "rzp_test_xxxx"
  }
}
```

### `POST /api/v1/payments/verify`
Verifies checkout signature returned by Razorpay Checkout.
**Request Body:**
```json
{
  "registrationReference": "SSS-2026-X8K2M9",
  "razorpay_order_id": "order_xxxx",
  "razorpay_payment_id": "pay_xxxx",
  "razorpay_signature": "signature_hex"
}
```

### `POST /api/v1/payments/webhook`
Receives asynchronous Razorpay webhooks (`order.paid`, `payment.captured`, `payment.failed`).
- Validates `X-Razorpay-Signature` against raw body buffer and `RAZORPAY_WEBHOOK_SECRET`.
- Processes events idempotently.

### `GET /api/v1/registrations/:reference/status`
Safe polling endpoint for frontend payment confirmation. Returns `{ status: "PAID" | "AWAITING_PAYMENT" }`.

### `POST /api/v1/registrations/:reference/retry-payment`
Generates a new Razorpay order if a payment was abandoned or failed, without re-entering form data.

---

## 7. cPanel Deployment Guide

### Option A: cPanel "Setup Node.js App" (Recommended)
1. In cPanel, navigate to **Software > Setup Node.js App**.
2. Click **Create Application**.
3. Select Node.js version: **18.x, 20.x, or 22.x LTS**.
4. Set Application root: `sss-api`.
5. Set Application startup file: `src/server.js`.
6. Add Environment variables in the cPanel UI (`DATABASE_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SMTP_HOST`, etc.).
7. Open cPanel Terminal (or SSH):
   ```bash
   cd sss-api
   npm install --production
   npx prisma generate
   npx prisma db push
   node prisma/seed.js
   ```
8. In the cPanel Node.js interface, click **Restart Application**.

### Option B: Apache Reverse Proxy
If running Node.js as a system service (e.g. via PM2 or systemd):
Add this to the Apache configuration or `.htaccess`:
```apache
<IfModule mod_proxy.c>
  ProxyPreserveHost On
  ProxyPass /api http://127.0.0.1:4000/api
  ProxyPassReverse /api http://127.0.0.1:4000/api
</IfModule>
```

---

## 8. Razorpay Webhook Configuration

1. In the **Razorpay Dashboard**, navigate to **Settings > Webhooks**.
2. Click **Add New Webhook**.
3. Webhook URL: `https://yourdomain.com/api/v1/payments/webhook`
4. Secret: Enter a strong random secret and copy it into `RAZORPAY_WEBHOOK_SECRET` in `.env`.
5. Active Events to select:
   - `order.paid`
   - `payment.captured`
   - `payment.failed`

---

## 9. cPanel SMTP Mailbox & DNS Configuration

To guarantee high email deliverability:
1. **Mailbox:** In cPanel, navigate to **Email Accounts** and create `contact@yourdomain.com`.
2. **Ports:** Port 465 with SSL (`SMTP_SECURE=true`) is recommended.
3. **SPF (Sender Policy Framework):** Ensure your domain's TXT record contains:
   `v=spf1 include:relay.mailchannels.net +ip4:your_server_ip ~all`
4. **DKIM:** Enable DKIM in cPanel under **Email Deliverability**.
5. **DMARC:** Add a TXT record for `_dmarc.yourdomain.com`:
   `v=DMARC1; p=none; sp=none; rua=mailto:dmarc-reports@yourdomain.com`

---

## 10. Database Backup and Restoration

### Backup (pg_dump)
```bash
pg_dump "postgres://user:password@host:5432/dbname?sslmode=require" -F c -b -v -f sss_backup_$(date +%Y%m%d).dump
```

### Restore (pg_restore)
```bash
pg_restore -d "postgres://user:password@host:5432/dbname?sslmode=require" -v sss_backup_20261014.dump
```

---

## 11. Checklist for Switching to Live Payment Mode

- [ ] Obtain Live API Keys (`rzp_live_...`) from Razorpay Dashboard.
- [ ] Update `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in production `.env`.
- [ ] Configure the live Webhook URL in Razorpay Dashboard and update `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Set `NODE_ENV=production` in production `.env`.
- [ ] Ensure HTTPS is active and SSL certificate is valid.
- [ ] Verify test transaction with a small amount on Live mode and confirm receipt email.
