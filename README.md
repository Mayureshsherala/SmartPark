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

## Raspberry Pi 3B+ prototype

`hardware/raspberry_pi_controller.py` operates the prototype wiring: six MFRC522 readers, six IR obstacle sensors, the 4x3 keypad, PCA9548A I2C multiplexer, DS3231 RTC, and a 16x2 I2C LCD. The controller reports every component's health to the admin **Hardware** page, sends a heartbeat every five seconds, and sends an RFID **entry** event while a vehicle is detected or an **exit** event after it leaves the slot.

### Install on the Pi

1. Enable **SPI** and **I2C** in `sudo raspi-config`. Disable the serial console because the prototype uses GPIO14 and GPIO15 for IR sensors.
2. Copy the repository to the Pi, then install the controller dependencies:

   ```bash
   cd /opt/smartpark
   python3 -m pip install -r hardware/pi_requirements.txt
   sudo mkdir -p /etc/smartpark
   sudo cp hardware/smartpark-pi.env.example /etc/smartpark/hardware.env
   sudo nano /etc/smartpark/hardware.env
   ```

3. Set `SMARTPARK_API_URL` to the Railway backend URL and copy the exact Railway `HARDWARE_API_KEY` into `hardware.env`.
4. Test with `python3 hardware/raspberry_pi_controller.py`. The LCD should show **SmartPark ready** and the admin Hardware page should show the prototype components.
5. To start automatically after every Pi reboot:

   ```bash
   sudo cp hardware/smartpark-pi.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now smartpark-pi
   sudo systemctl status smartpark-pi
   ```

### Prototype use

- Use the keypad to choose parking duration: enter `1`–`12`, then press `#`. Press `*` to clear the entered duration.
- Place a vehicle at a slot, then tap its RFID card on the reader for that slot to start parking.
- Remove the vehicle, then tap the same card at the same reader to close the parking session.
- The six LEDs are intentionally not driven in this reduced prototype list. Add the MCP23017 plus one resistor per LED to control them independently.

## Database migrations

For an existing database, apply `database/migrations/002_spec_alignment.sql`, `database/migrations/003_messaging_auth.sql`, `database/migrations/004_login_dual_otp.sql`, `database/migrations/005_fastag_qr_refunds.sql`, and `database/migrations/006_phonepe_uat.sql` once. The messaging migrations add verification, password-reset, and login OTP storage.

## Billing and services

`SECONDS_PER_HOUR=5` makes one parking hour equal five seconds for demos. Set it to `3600` in production. Standard billing is Rs.20 per registered hour, while every started extra hour is Rs.40. Monthly-pass sessions are logged at Rs.0.

Razorpay and SMTP are optional during local development; leave their variables empty to use the built-in demo order path and console-only email notifications. Set their `.env` values before production use.

## Razorpay checkout

SmartPark uses Razorpay Checkout for the online Rs.20 pre-booking advance. The server creates the order and verifies Razorpay's payment signature before it reserves a slot or issues the payment receipt.

1. In Razorpay Dashboard, switch to Live Mode and generate Live API keys from **Account & Settings → API Keys**.
2. Add the keys to `backend/.env`; never put the secret in the frontend, Git, or a chat:
   ```env
   RAZORPAY_KEY_ID=rzp_live_your_key_id
   RAZORPAY_KEY_SECRET=your_live_key_secret
   ```
3. Restart `npm run dev`, then choose **Razorpay payment** while booking. Razorpay Checkout presents the supported UPI, QR, card, net-banking, and wallet methods.

For public real payments, the backend and database must also be deployed to a public HTTPS URL; the Vercel frontend alone cannot process SmartPark API requests.

## Public deployment: Vercel + Railway

Use Vercel for the React frontend and Railway for the persistent Express API and MySQL database. The Vercel site needs a public API address; without it, requests to `/api` remain on Vercel and registration, login, bookings, payments, and the live map cannot work.

### 1. Deploy MySQL and the API on Railway

1. Create a new Railway project at [railway.app](https://railway.app/).
2. Click **New** → **Database** → **MySQL**.
3. Click **New** → **GitHub Repo**, select this `SmartPark` repository, and name the service `smartpark-api`.
4. Keep its root directory as `/`. The committed `railway.toml` builds `backend/Dockerfile`, runs the database bootstrap before deployment, and checks `/api/health`.
5. In the API service's **Variables** tab, add these values. Replace `YOUR_VERCEL_DOMAIN` only with your production Vercel address:

   ```env
   NODE_ENV=production
   CLIENT_ORIGIN=https://YOUR_VERCEL_DOMAIN.vercel.app
   JWT_SECRET=use-a-new-long-random-secret-here
   JWT_EXPIRES_IN=7d
   DB_HOST=${{MySQL.MYSQLHOST}}
   DB_PORT=${{MySQL.MYSQLPORT}}
   DB_NAME=${{MySQL.MYSQLDATABASE}}
   DB_USER=${{MySQL.MYSQLUSER}}
   DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}
   SECONDS_PER_HOUR=3600
   NORMAL_RATE=20
   OVERTIME_RATE=40
   HARDWARE_API_KEY=use-a-separate-long-random-key
   INITIAL_ADMIN_NAME=Your Name
   INITIAL_ADMIN_EMAIL=your-real-email@example.com
   INITIAL_ADMIN_PASSWORD=choose-a-strong-password-with-a-number
   ```

   Also add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and the SMTP variables if you use real payments and email OTPs. Keep all secrets only in Railway; never add them to GitHub or Vercel.
6. Generate a public Railway domain. Open `https://YOUR_RAILWAY_DOMAIN/api/health`; it must report `database: connected`.

The first successful Railway deploy creates the tables from `database/schema.sql` and creates the initial admin once. It never imports the local demo users or overwrites an existing production database.

### 2. Point Vercel at the API

1. Open the Vercel project → **Settings** → **Environment Variables**.
2. Add the following Production variable, then redeploy the `main` branch:

   ```env
   VITE_API_URL=https://YOUR_RAILWAY_DOMAIN
   ```

3. Open the Vercel URL and create an account using a real email address. The frontend sends its access token to the Railway API, so registration and login work even though the sites use separate domains.

For Preview deployments, add the preview Vercel URL to `CLIENT_ORIGIN` as a comma-separated value, or use a shared custom domain. Once you buy a domain, use `app.yourdomain.com` for Vercel and `api.yourdomain.com` for Railway, then set `CLIENT_ORIGIN=https://app.yourdomain.com`.

### 3. Production checks

- Confirm `/api/health` reports a connected database before opening Vercel.
- Confirm registration sends an SMTP verification OTP and login sends a login OTP.
- Confirm Razorpay Checkout opens using a live key and that a successful payment appears in the admin **Payments** page.
- Configure the Raspberry Pi / ESP device to post to `https://YOUR_RAILWAY_DOMAIN/api/hardware/event` with the production `HARDWARE_API_KEY`.
- Enable Railway MySQL backups and do not expose its TCP proxy publicly unless you need administrative database access.

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
