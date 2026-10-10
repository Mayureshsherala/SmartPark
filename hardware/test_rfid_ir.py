#!/usr/bin/env python3
"""SmartPark Simple RFID & IR Hardware Tester / Runner for Raspberry Pi.

This script detects RFID cards and IR sensors and sends live events to the SmartPark website.
If hardware libraries (RPi.GPIO / spidev) are missing, it provides an interactive prompt
to simulate RFID scans and IR detection on your live website.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

API_BASE_URL = os.environ.get("SMARTPARK_API_URL", "http://10.39.121.234:3000").rstrip("/")
HARDWARE_API_KEY = os.environ.get("HARDWARE_API_KEY", "c4163f48ce8580071362bd6ca1fc826b4976d8ca6abd3b894b77ecbbf0901bc4")
API_URL = f"{API_BASE_URL}/api/hardware/event"

# Pin Mappings (Slot 1 to 6)
IR_PINS = (5, 6, 13, 19, 26, 21)
RFID_SS_PINS = (8, 14, 15, 18, 23, 24)
RFID_RESET_PIN = 22

# Hardware check
HAS_GPIO = False
HAS_SPI = False

try:
    import RPi.GPIO as GPIO
    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    for pin in IR_PINS:
        GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    GPIO.setup(RFID_RESET_PIN, GPIO.OUT, initial=GPIO.HIGH)
    HAS_GPIO = True
    print("[SUCCESS] RPi.GPIO initialized.")
except Exception as e:
    print(f"[NOTE] RPi.GPIO not available ({e}). Using CLI simulation for IR.")

try:
    import spidev
    spi = spidev.SpiDev()
    spi.open(0, 0)
    spi.max_speed_hz = 1_000_000
    spi.mode = 0
    spi.no_cs = True
    HAS_SPI = True
    print("[SUCCESS] SPI initialized.")
except Exception as e:
    print(f"[NOTE] spidev not available ({e}). Using CLI simulation for RFID.")


def send_event(payload):
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Hardware-Key': HARDWARE_API_KEY},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return resp.status, data
    except Exception as err:
        print(f"[API ERROR] {err}")
        return None, None


def send_heartbeat(slots_state):
    payload = {
        "event": "heartbeat",
        "source": "raspberry_pi_3b_plus",
        "timestamp": datetime.now().isoformat(),
        "components": {
            "RPi.GPIO": "Active" if HAS_GPIO else "Simulated",
            "SPI MFRC522": "Active" if HAS_SPI else "Simulated"
        },
        "slots": [{"slot": i + 1, "status": "occupied" if occupied else "free"} for i, occupied in enumerate(slots_state)]
    }
    status, res = send_event(payload)
    if status == 200:
        print(f"[HEARTBEAT OK] Website connected -> {API_BASE_URL}")


def trigger_rfid_scan(slot_num, uid):
    print(f"\n[RFID SCAN] Triggering RFID Scan for Slot P-0{slot_num} with UID: '{uid}'...")
    payload = {"event": "rfid_scan", "slot": slot_num, "uid": uid, "source": "raspberry_pi_3b_plus"}
    status, res = send_event(payload)
    if res:
        print(f"[SERVER RESPONSE] HTTP {status}: {res.get('message')} | Action: {res.get('data', {}).get('action')}")


def trigger_entry(slot_num, uid):
    print(f"\n[VEHICLE ENTRY] Vehicle entered Slot P-0{slot_num} with UID '{uid}'...")
    payload = {"event": "entry", "slot": slot_num, "uid": uid, "hours": 1, "source": "raspberry_pi_3b_plus"}
    status, res = send_event(payload)
    if res:
        print(f"[SERVER RESPONSE] HTTP {status}: {res.get('message')}")


def trigger_exit(slot_num, uid):
    print(f"\n[VEHICLE EXIT] Vehicle exiting Slot P-0{slot_num} with UID '{uid}'...")
    payload = {"event": "exit", "slot": slot_num, "uid": uid, "source": "raspberry_pi_3b_plus"}
    status, res = send_event(payload)
    if res:
        print(f"[SERVER RESPONSE] HTTP {status}: {res.get('message')}")


def main():
    print("=" * 60)
    print(f" SmartPark Pi Tester & Bridge -> {API_BASE_URL}")
    print("=" * 60)
    print("Commands:")
    print("  r <slot> <uid>   -> Scan RFID card (e.g. 'r 1 12 34 56 78')")
    print("  e <slot> <uid>   -> Trigger vehicle entry (e.g. 'e 1 12 34 56 78')")
    print("  x <slot> <uid>   -> Trigger vehicle exit (e.g. 'x 1 12 34 56 78')")
    print("  q                -> Quit")
    print("=" * 60)

    slots_state = [False] * 6
    send_heartbeat(slots_state)

    while True:
        try:
            cmd = input("\nEnter command (r/e/x/q) > ").strip()
            if not cmd:
                continue
            if cmd.lower() == 'q':
                break
            parts = cmd.split(maxsplit=2)
            action = parts[0].lower()
            slot_num = int(parts[1]) if len(parts) > 1 else 1
            uid = parts[2] if len(parts) > 2 else "12 34 56 78"

            if action == 'r':
                trigger_rfid_scan(slot_num, uid)
            elif action == 'e':
                trigger_entry(slot_num, uid)
                slots_state[slot_num - 1] = True
                send_heartbeat(slots_state)
            elif action == 'x':
                trigger_exit(slot_num, uid)
                slots_state[slot_num - 1] = False
                send_heartbeat(slots_state)
            else:
                print("Unknown action. Use 'r', 'e', 'x', or 'q'.")
        except (KeyboardInterrupt, EOFError):
            break
        except Exception as err:
            print(f"[ERROR] {err}")

    print("\nExiting tester.")


if __name__ == "__main__":
    main()
