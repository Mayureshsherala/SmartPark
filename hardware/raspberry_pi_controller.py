#!/usr/bin/env python3
"""SmartPark Raspberry Pi 3B+ Full Hardware Controller & Web Bridge.

Configured with Adafruit ServoKit (PCA9685 16-channel), rpi_lcd (address 0x27),
six MFRC522 SPI RFID readers, six IR obstacle sensors, and SmartPark Web API integration.
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

# ---------------- CONFIGURATION ----------------
API_BASE_URL = os.environ.get("SMARTPARK_API_URL", "http://10.250.115.234:3000").rstrip("/")
HARDWARE_API_KEY = os.environ.get("HARDWARE_API_KEY", "c4163f48ce8580071362bd6ca1fc826b4976d8ca6abd3b894b77ecbbf0901bc4")
API_URL = f"{API_BASE_URL}/api/hardware/event"
HEARTBEAT_SECONDS = max(2, int(os.environ.get("HEARTBEAT_SECONDS", "5")))

# Pin Mapping (BCM Numbers)
IR_PINS = {1: 5, 2: 6, 3: 13, 4: 19, 5: 26, 6: 21}
CS_PINS = [8, 14, 15, 18, 23, 24]  # Slot 1 to 6 RFID Chip Select
RST_PIN = 22                        # Shared RFID Reset Pin

SERVO_CHANNELS = {1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}
CLOSED = 90
OPEN = 0
PULSE_MIN = 500
PULSE_MAX = 2500

# ---------------- HARDWARE INITIALIZATION ----------------
HAS_GPIO = False
HAS_SPI = False
HAS_SERVOKIT = False
HAS_LCD = False

try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    for pin in IR_PINS.values():
        GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    for cs in CS_PINS:
        GPIO.setup(cs, GPIO.OUT, initial=GPIO.HIGH)
    GPIO.setup(RST_PIN, GPIO.OUT, initial=GPIO.HIGH)
    HAS_GPIO = True
    print("[HARDWARE] RPi.GPIO initialized successfully with PUD_UP on IR pins.")
except Exception as err:
    print(f"[MOCK] RPi.GPIO not available ({err}). Running GPIO in mock mode.")

try:
    import spidev
    spi = spidev.SpiDev()
    spi.open(0, 0)
    spi.no_cs = True
    spi.max_speed_hz = 500000
    spi.mode = 0
    HAS_SPI = True
    print("[HARDWARE] SPI bus initialized successfully.")
except Exception as err:
    print(f"[MOCK] SPI bus not available ({err}). Running SPI in mock mode.")

servos = {}
try:
    from adafruit_servokit import ServoKit
    kit = ServoKit(channels=16)
    for slot_num, channel in SERVO_CHANNELS.items():
        s = kit.servo[channel]
        s.set_pulse_width_range(PULSE_MIN, PULSE_MAX)
        servos[slot_num] = s
        s.angle = CLOSED
    HAS_SERVOKIT = True
    print("[HARDWARE] Adafruit ServoKit initialized. Gates set to CLOSED (90°).")
except Exception as err:
    print(f"[MOCK] Adafruit ServoKit not available ({err}). Servos in mock mode.")

lcd_dev = None
try:
    from rpi_lcd import LCD
    lcd_dev = LCD(address=0x27)
    HAS_LCD = True
    print("[HARDWARE] I2C LCD (0x27) initialized successfully.")
except Exception as err:
    print(f"[MOCK] I2C LCD not available ({err}). LCD in mock mode.")


# ---------------- RFID LOW-LEVEL SPI FUNCTIONS ----------------
def rfid_write(cs, reg, val):
    if not HAS_GPIO or not HAS_SPI:
        return
    GPIO.output(cs, 0)
    spi.xfer2([(reg << 1) & 0x7E, val])
    GPIO.output(cs, 1)

def rfid_read(cs, reg):
    if not HAS_GPIO or not HAS_SPI:
        return 0
    GPIO.output(cs, 0)
    val = spi.xfer2([((reg << 1) & 0x7E) | 0x80, 0])[1]
    GPIO.output(cs, 1)
    return val

def rfid_bits(cs, reg, mask):
    rfid_write(cs, reg, rfid_read(cs, reg) | mask)

def init_rfid(cs):
    rfid_write(cs, 1, 0x0F)
    rfid_write(cs, 0x2A, 0x8D)
    rfid_write(cs, 0x2B, 0x3E)
    rfid_write(cs, 0x2D, 30)
    rfid_write(cs, 0x2C, 0)
    rfid_write(cs, 0x15, 0x40)
    rfid_write(cs, 0x11, 0x3D)
    rfid_bits(cs, 0x14, 3)

def rfid_transfer(cs, data, framing=0):
    rfid_write(cs, 1, 0)
    rfid_write(cs, 4, 0x7F)
    rfid_write(cs, 0x0A, 0x80)
    rfid_write(cs, 0x0D, framing)
    for b in data:
        rfid_write(cs, 9, b)
    rfid_write(cs, 1, 0x0C)
    rfid_bits(cs, 0x0D, 0x80)
    end = time.monotonic() + 0.05
    irq = 0
    while time.monotonic() < end:
        irq = rfid_read(cs, 4)
        if irq & 0x30 or irq & 1:
            break
    rfid_write(cs, 0x0D, framing)
    if not irq & 0x30 or rfid_read(cs, 6) & 0x1B:
        return None
    return [rfid_read(cs, 9) for _ in range(rfid_read(cs, 0x0A))]

def rfid_scan(cs):
    if not HAS_GPIO or not HAS_SPI:
        return None
    atqa = rfid_transfer(cs, [0x26], 0x07)
    if not atqa or len(atqa) != 2:
        return None
    uid = rfid_transfer(cs, [0x93, 0x20])
    if uid and len(uid) == 5:
        if uid[0] ^ uid[1] ^ uid[2] ^ uid[3] == uid[4]:
            return " ".join(f"{b:02X}" for b in uid[:4])
    return None


# ---------------- HARDWARE CONTROL HELPERS ----------------
def vehicle_detected(slot_num):
    if HAS_GPIO:
        pin = IR_PINS.get(slot_num)
        if pin:
            return GPIO.input(pin) == 0
    return False

def open_barrier(slot_num):
    print(f"[BARRIER] Opening barrier for Slot P-0{slot_num} (Angle {OPEN}°)...")
    if slot_num in servos:
        try:
            servos[slot_num].angle = OPEN
        except Exception as e:
            print(f"[BARRIER ERROR] {e}")

def close_barrier(slot_num):
    print(f"[BARRIER] Closing barrier for Slot P-0{slot_num} (Angle {CLOSED}°)...")
    if slot_num in servos:
        try:
            servos[slot_num].angle = CLOSED
        except Exception as e:
            print(f"[BARRIER ERROR] {e}")

def update_lcd(occupancy_list, line1=None, line2=None):
    if not HAS_LCD or not lcd_dev:
        return
    try:
        if line1 is not None:
            lcd_dev.text(line1[:16].ljust(16), 1)
            lcd_dev.text((line2 or "")[:16].ljust(16), 2)
        else:
            s = ["O" if occ else "F" for occ in occupancy_list]
            lcd_dev.text(f"1:{s[0]} 2:{s[1]} 3:{s[2]}     ", 1)
            lcd_dev.text(f"4:{s[3]} 5:{s[4]} 6:{s[5]}     ", 2)
    except Exception:
        pass


# ---------------- WEB API COMMUNICATION ----------------
class SmartParkApi:
    def post(self, payload):
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Hardware-Key": HARDWARE_API_KEY},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            print(f"[API HTTP ERROR {error.code}] {body}")
            return error.code, {}
        except Exception as error:
            print(f"[API CONNECTION ERROR] {error}")
            return None, {}

    def get(self, path):
        req = urllib.request.Request(
            f"{API_BASE_URL}{path}",
            headers={"X-Hardware-Key": HARDWARE_API_KEY},
            method="GET"
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except Exception as error:
            print(f"[API GET ERROR] {error}")
            return None, {}


# ---------------- MAIN APPLICATION ----------------
def main():
    print("=" * 65)
    print(f" SmartPark Controller -> Server: {API_BASE_URL}")
    print("=" * 65)

    if HAS_GPIO and HAS_SPI:
        GPIO.output(RST_PIN, 0)
        time.sleep(0.05)
        GPIO.output(RST_PIN, 1)
        time.sleep(0.05)
        for i, cs in enumerate(CS_PINS, start=1):
            init_rfid(cs)
            fw = rfid_read(cs, 0x37)
            print(f"[RFID] Reader Slot {i} (GPIO {cs}): Firmware 0x{fw:02X}")

    api = SmartParkApi()

    # Slot States: "IDLE", "WAITING_FOR_CAR", "WAITING_TO_CLEAR"
    slot_states = ["IDLE"] * 6
    occupancy = [False] * 6
    assigned_uids = [None] * 6
    last_scanned_uids = [None] * 6
    last_heartbeat = 0
    last_gate_sync = 0

    update_lcd(occupancy, "SmartPark Ready", "Scan card / web")

    while True:
        now_time = time.monotonic()

        # Update current occupancy from IR sensors
        for i in range(6):
            occupancy[i] = vehicle_detected(i + 1)

        # 1. Send Periodic Heartbeat to Server
        if now_time - last_heartbeat >= HEARTBEAT_SECONDS:
            last_heartbeat = now_time
            hb_payload = {
                "event": "heartbeat",
                "source": "raspberry_pi_3b_plus",
                "timestamp": datetime.now().isoformat(),
                "components": {
                    "DS3231 RTC": "Ready",
                    "16x2 LCD": "Ready (0x27)" if HAS_LCD else "Not detected",
                    "I2C Servo Driver": "Ready (PCA9685)" if HAS_SERVOKIT else "Not detected",
                    "IR Sensors": "6 Channels Active" if HAS_GPIO else "Mock mode",
                    "RFID Readers": "6 SPI Active" if (HAS_GPIO and HAS_SPI) else "Mock mode"
                },
                "slots": [{"slot": i + 1, "status": "occupied" if occupancy[i] else "free"} for i in range(6)]
            }
            api.post(hb_payload)

        # 2. Check Authorized Exits from Server (online exit payment completed)
        if now_time - last_gate_sync >= 1.0:
            last_gate_sync = now_time
            status_code, resp_data = api.get("/api/hardware/gates")
            if status_code == 200:
                gates = resp_data.get("data", [])
                for g in gates:
                    slot_id = int(g["slot_id"])
                    idx = slot_id - 1
                    gate_open = (g.get("gate_status") == "open" and g.get("exit_authorization_expires_at"))
                    if gate_open and slot_states[idx] == "IDLE" and occupancy[idx]:
                        print(f"[SERVER EXIT AUTH] Slot P-0{slot_id} exit authorized. Opening gate...")
                        update_lcd(occupancy, f"Slot {slot_id}:Exit Auth", "Drive Out Now")
                        open_barrier(slot_id)
                        slot_states[idx] = "WAITING_TO_CLEAR"

        # 3. Main Loop per Slot
        for i in range(6):
            slot_num = i + 1
            cs_pin = CS_PINS[i]
            state = slot_states[i]

            # --- STATE 1: IDLE (Scanning for RFID) ---
            if state == "IDLE":
                scanned_uid = rfid_scan(cs_pin) if (HAS_GPIO and HAS_SPI) else None
                if scanned_uid and scanned_uid != last_scanned_uids[i]:
                    last_scanned_uids[i] = scanned_uid
                    print(f"\n[RFID SCAN] Slot P-0{slot_num} Tag: {scanned_uid}")

                    # 1. Check if tag is already active in another slot
                    is_already_in_use = any(assigned_uids[k] == scanned_uid for k in range(6) if k != i and assigned_uids[k] is not None)
                    if is_already_in_use:
                        print(f"[REJECTED] Slot P-0{slot_num}: Tag {scanned_uid} is already active in another slot!")
                        update_lcd(occupancy, f"Slot {slot_num}:Denied", "Card In Use")
                        time.sleep(1.5)
                        continue

                    # 2. If slot is occupied -> Exit Phase (Check FASTag / Exit Payment)
                    if occupancy[i]:
                        print(f"[EXIT ATTEMPT] Slot P-0{slot_num}: Checking exit authorization...")
                        status, res = api.post({
                            "event": "rfid_scan",
                            "slot": slot_num,
                            "uid": scanned_uid,
                            "source": "raspberry_pi_3b_plus"
                        })
                        action = res.get("data", {}).get("action")
                        msg = res.get("message", "Pay online to exit")

                        if action == "open_exit_gate" or status == 200:
                            print(f"[EXIT AUTHORIZED] FASTag/Online payment verified! Opening gate for Slot P-0{slot_num}...")
                            update_lcd(occupancy, f"Slot {slot_num}:Paid Exit", "Drive Out Now")
                            open_barrier(slot_num)
                            slot_states[i] = "WAITING_TO_CLEAR"
                        else:
                            print(f"[PAYMENT REQUIRED] Slot P-0{slot_num}: {msg}")
                            update_lcd(occupancy, f"Slot {slot_num}:Pay Exit", msg[:16])


                    # 3. Entry Phase (Server verifies 'Arrived at Slot' status on web & assigns tag)
                    else:
                        status, res = api.post({
                            "event": "rfid_scan",
                            "slot": slot_num,
                            "uid": scanned_uid,
                            "source": "raspberry_pi_3b_plus"
                        })
                        action = res.get("data", {}).get("action")
                        message = res.get("message", "RFID scanned")

                        if action == "awaiting_vehicle":
                            print(f"[ACCESS GRANTED] Tag '{scanned_uid}' assigned! Opening gate for Slot P-0{slot_num}...")
                            update_lcd(occupancy, f"Slot {slot_num}:Granted", "Drive In Now")
                            open_barrier(slot_num)
                            assigned_uids[i] = scanned_uid
                            slot_states[i] = "WAITING_FOR_CAR"
                        else:
                            print(f"[LOCKED/DENIED] Slot P-0{slot_num}: {message}")
                            update_lcd(occupancy, f"Slot {slot_num}:Locked", "Press Web Button")
                            time.sleep(1.5)

                elif not scanned_uid:
                    last_scanned_uids[i] = None

            # --- STATE 2: WAITING FOR CAR TO ENTER AND PARK ---
            elif state == "WAITING_FOR_CAR":
                if vehicle_detected(slot_num):
                    time.sleep(0.4)
                    print(f"[ENTRY CONFIRMED] Vehicle parked at Slot P-0{slot_num}. Closing gate.")
                    close_barrier(slot_num)
                    
                    uid_to_send = assigned_uids[i] or "12 34 56 78"
                    api.post({
                        "event": "entry",
                        "slot": slot_num,
                        "uid": uid_to_send,
                        "hours": 1,
                        "source": "raspberry_pi_3b_plus"
                    })

                    update_lcd(occupancy, f"Slot {slot_num}:Parked", "Entry Recorded")
                    time.sleep(1.5)
                    slot_states[i] = "IDLE"

            # --- STATE 3: WAITING FOR CAR TO LEAVE SLOT ---
            elif state == "WAITING_TO_CLEAR":
                if not vehicle_detected(slot_num):
                    time.sleep(0.5)
                    print(f"[EXIT CONFIRMED] Vehicle left Slot P-0{slot_num}. Closing gate.")
                    close_barrier(slot_num)

                    uid_to_send = assigned_uids[i] or "12 34 56 78"
                    api.post({
                        "event": "exit",
                        "slot": slot_num,
                        "uid": uid_to_send,
                        "source": "raspberry_pi_3b_plus"
                    })

                    update_lcd(occupancy, f"Slot {slot_num}:Cleared", "Exit Recorded")
                    assigned_uids[i] = None
                    time.sleep(1.5)
                    slot_states[i] = "IDLE"

        # Display general slot occupancy status on LCD when idle
        if all(st == "IDLE" for st in slot_states):
            update_lcd(occupancy)

        time.sleep(0.04)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[STOPPING] SmartPark Controller shutting down...")
        if HAS_LCD and lcd_dev:
            try:
                lcd_dev.clear()
                lcd_dev.text("System Stopped", 1)
            except Exception:
                pass
    finally:
        for slot_num in range(1, 7):
            close_barrier(slot_num)
        if HAS_SPI:
            try:
                spi.close()
            except Exception:
                pass
        if HAS_GPIO:
            try:
                GPIO.cleanup()
            except Exception:
                pass
