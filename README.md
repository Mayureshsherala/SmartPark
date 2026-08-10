# SmartPark — IoT Smart Parking Management

A responsive, Raspberry Pi-friendly parking system with RFID hardware events, live Socket.io slot status, user bookings, automatic time-scaled billing, payment records, and a mobile-ready admin dashboard.

## Included

- React 18 + Vite frontend with live slot map, booking, sessions, profile, dark mode, and responsive mobile navigation.
- Express + MySQL API with JWT authentication, role-based administration, hardware event handling, reports, receipts, notifications, and Razorpay order support.
- MySQL schema and development seed data.
- ESP8266 sketch posting entry, exit, release, and five-second heartbeat JSON events.

## Quick start (development)

1. Install MySQL 8 and create the database tables:
   ```bash
   mysql -u root -p < database/schema.sql
   mysql -u root -p < database/seed.sql
   ```
2. Copy `.env.example` to `backend/.env` and update the MySQL and JWT values.
3. Install dependencies:
   ```bash
   npm install
   npm run install:all
   ```
4. Start both applications:
   ```bash
   npm run dev
   ```
   This automatically starts the Docker MySQL database when Docker Desktop is open; no separate Docker command is needed.
5. Open `http://localhost:5173`. The API runs at `http://localhost:3000`.

## Quick start (Docker)

With Docker Desktop running, start the entire application and MySQL database from the project root:

```bash
docker compose up --build
```

Open `http://localhost:3001`. Docker automatically creates the database, imports the schema and sample accounts, builds the frontend, and serves it from the Express server. MySQL remains internal to Docker, avoiding any `3306` conflict with local development tools.

Use the administrator credentials `admin@smartpark.local` / `admin123`.

To stop the containers, press `Ctrl+C`, then run:

```bash
docker compose down
```

To fully reset the database and reload sample data:

```bash
docker compose down -v
docker compose up --build
```

Sample accounts use password `parking123`:

- Administrator: `admin@smartpark.local`
- User: `rahul@example.com`

## Production deployment on Raspberry Pi

```bash
sudo apt update
sudo apt install nodejs npm mysql-server
git clone <your-repository-url> parking-system
cd parking-system
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed.sql
cp .env.example backend/.env
npm install
npm run install:all
npm run build
cp -r frontend/dist backend/public
cd backend && node server.js
```

The server listens on port `3000` and serves the built frontend. Configure the Pi hotspot:

```bash
sudo nmcli dev wifi hotspot ifname wlan0 ssid SmartParking password parking123
```

Connect the ESP8266 to this network and browse to `http://192.168.4.1:3000`.

## Hardware event API

The Raspberry Pi GPIO script must post to `POST /api/hardware/event` with the `X-Hardware-Key` header set to the value of `HARDWARE_API_KEY` in `backend/.env`. Every raw payload is recorded in `hardware_events` for the admin hardware log. The legacy `POST /api/event` endpoint remains available for earlier ESP8266 demos.

The Pi endpoint accepts these JSON bodies:

```json
{ "event": "entry", "slot": 2, "uid": "42 12 DB E9", "registered_hours": 2, "entry_time": "2026-08-02T10:30:00" }
```

```json
{ "event": "exit", "slot": 2, "uid": "42 12 DB E9" }
```

```json
{ "event": "ir_timeout", "slot": 3, "uid": "D0 32 4C 5F", "reason": "no_vehicle_10s" }
```

```json
{ "event": "heartbeat", "slots": [{ "slot": 1, "status": "occupied", "uid": "42 12 DB E9" }, { "slot": 2, "status": "free", "uid": null }] }
```

An unregistered card can be reported as `{ "event": "unknown_rfid", "slot": 4, "uid": "XX XX XX XX" }`. All real-time clients receive `slotStatusChange`, `heartbeatSync`, `billTick`, `newBooking`, `unknownRFID`, `hardwareDisconnect`, and legacy-compatible slot events via Socket.io.

## Database migrations

For an existing database, apply `database/migrations/002_spec_alignment.sql`, `database/migrations/003_messaging_auth.sql`, `database/migrations/004_login_dual_otp.sql`, and `database/migrations/005_fastag_qr_refunds.sql` once. The messaging migrations add verification, password-reset, and login OTP storage.

## Billing and services

`SECONDS_PER_HOUR=5` makes one parking hour equal five seconds for demos. Set it to `3600` in production. Standard billing is Rs.20 per registered hour, while every started extra hour is Rs.40. Monthly-pass sessions are logged at Rs.0.

Razorpay and SMTP are optional during local development; leave their variables empty to use the built-in demo order path and console-only email notifications. Set their `.env` values before production use.

## Email alerts

SmartPark requires an email OTP after a correct password before it creates a login session. It also sends account verification and password-reset OTPs, password-change confirmations, RFID activation alerts, booking updates, payment confirmations, and parking entry/exit alerts. Configure these variables in `backend/.env` to deliver real emails:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=SmartPark <noreply@your-domain.com>

```

For local development, unset credentials cause alerts to be logged in the backend terminal instead of sent. OTPs expire after 10 minutes. The API endpoints are `POST /api/auth/email-verification/send`, `POST /api/auth/email-verification/confirm`, `POST /api/auth/password-reset/request`, and `POST /api/auth/password-reset/confirm`.

## FASTag, QR, and refunds

The payment centre creates UPI QR codes and supports a SmartPark FASTag sandbox wallet for end-to-end demonstrations. Users can link one vehicle-matched tag, top up its demo balance, pay unpaid bookings, and request refunds. Admins approve, reject, or process requests; processed FASTag refunds credit the sandbox wallet. A production FASTag auto-debit service requires a contracted bank/acquirer or authorised NPCI partner API and must replace the sandbox adapter before real money is used.

## Project layout

- `backend/` — API, Socket.io, database access, event/billing utilities.
- `frontend/` — Vite React PWA-ready interface.
- `database/schema.sql` — MySQL schema and initial slot/rate setup.
- `database/seed.sql` — local test users.
- `hardware/esp8266_smart_parking.ino` — ESP8266 event sender foundation.
