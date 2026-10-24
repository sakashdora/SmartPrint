# SmartPrint — Production Deployment Runbook (Render & Shop PC)

This runbook provides step-by-step instructions for deploying SmartPrint to Render, configuring Neon PostgreSQL, and setting up the Windows Print Agent on the shop counter computer.

---

## 1. Cloud Web Service (Render) Setup

### A. Service Specifications
- **Service Type:** Web Service
- **Runtime:** Node
- **Plan:** Free or Starter
- **Build Command:** `npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/api/health`
- **Auto Deploy:** Enabled on `main` branch

### B. Required Environment Variables

| Variable Name | Description | Example / Format |
| :--- | :--- | :--- |
| `NODE_ENV` | Set to `production` | `production` |
| `PORT` | Web server port (Render defaults to 10000 or 3000) | `3000` |
| `PUBLIC_BASE_URL` | Canonical public HTTPS URL of the service | `https://smartprint-ieks.onrender.com` |
| `DATABASE_URL` | Neon PostgreSQL pooled connection string | `postgresql://user:pass@ep-xyz-pooler.region.neon.tech/dbname?sslmode=verify-full` |
| `FILE_ENCRYPTION_KEY` | 32-byte hexadecimal AES-256 encryption key | 64 hex characters (generated via `crypto.randomBytes(32)`) |
| `CRON_SECRET` | Secret bearer token for `/maintenance` sweeps | 32+ character random string |
| `ADMIN_EMAIL` | Superadmin initial login email | `admin@yourdomain.com` |
| `ADMIN_PASSWORD` | Superadmin initial login password (min 12 chars)| Complex passphrase |
| `RAZORPAY_KEY_ID` | Optional: Razorpay Key ID (if using gateway) | `rzp_live_...` (leave empty for UPI-only mode) |
| `RAZORPAY_KEY_SECRET` | Optional: Razorpay Key Secret | Secure secret |
| `RAZORPAY_WEBHOOK_SECRET`| Optional: Razorpay Webhook Secret | Webhook secret |

> [!IMPORTANT]
> Never commit actual secret values to source control or logs. The values above are names and format descriptions only.

---

## 2. Database Migration & Initialization

1. SmartPrint uses zero-downtime, non-destructive schema migrations.
2. In production, tables are scoped within the `smartprint` schema in PostgreSQL.
3. Migrations execute automatically on startup if missing, or can be run explicitly:
   ```bash
   npm run migrate
   ```
4. **Rollback Strategy:** All schema changes are strictly additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). Forward migrations preserve existing customer orders and transaction history.

---

## 3. Windows Print Agent Setup on the Shop PC

The shop counter PC running Windows 10/11 connects physical printers (e.g., Brother DCP-T820DW, HP LaserJet) to the cloud backend.

### Prerequisites on Shop PC:
1. Windows 10 or 11 with printer connected via USB cable or local WiFi network.
2. Node.js v20+ installed on the Windows PC.
3. The shop printer installed and functional in Windows Printers & Scanners.

### Setup Steps:
1. Clone or download the SmartPrint project folder to the shop PC.
2. Open the Shop Owner Dashboard on the shop PC browser (e.g., `https://smartprint-ieks.onrender.com/#printers`).
3. Pair your printer: Click **"Connect Printer"** to generate a paired device token.
4. Launch the connector with the provided launcher batch script:
   ```cmd
   start-connector.bat
   ```
   Or run directly via command prompt:
   ```cmd
   set SMARTPRINT_URL=https://smartprint-ieks.onrender.com
   set SMARTPRINT_DEVICE_TOKEN=your_device_token_from_dashboard
   set SMARTPRINT_PRINTER=Brother DCP-T820DW Printer
   node connector/index.js
   ```
5. The connector will automatically download portable `SumatraPDF.exe` (if not already present), verify the printer port, and begin listening for paid print jobs.
6. Verify in the dashboard that the printer indicator turns **Online (Green)**.

---

## 4. Cold-Start & Health Monitoring

- **Health Check Endpoint:** `GET /api/health` returns `200 OK` with service mode, gateway status, and office conversion status.
- **Readiness Probe:** `GET /readyz` verifies that database maintenance sweeps have executed successfully within the last 3 minutes.
- **Render Free Tier Note:** Render free tier services sleep after 15 minutes of inactivity. When a customer scans a QR code after a sleep period, allow 30–45 seconds for initial container wake-up. For zero-delay customer experiences at busy shop counters, upgrading to Render's starter plan prevents spin-downs.
