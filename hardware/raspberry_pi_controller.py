#!/usr/bin/env python3
"""SmartPark Raspberry Pi 3B+ prototype controller.

Wiring: six MFRC522 readers on shared SPI with individual SS pins, six IR
sensors, a 4x3 keypad, and a PCA9548A with DS3231 on channel 0 and LCD on
channel 1. Each RFID scan starts a session when a vehicle is detected, or
ends the session after the vehicle has left the same slot.
"""

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime

import RPi.GPIO as GPIO
import spidev
from smbus2 import SMBus

API_BASE_URL = os.environ.get("SMARTPARK_API_URL", "").rstrip("/")
HARDWARE_API_KEY = os.environ.get("HARDWARE_API_KEY", "")
API_URL = f"{API_BASE_URL}/api/hardware/event"
HEARTBEAT_SECONDS = max(2, int(os.environ.get("HEARTBEAT_SECONDS", "5")))
IR_ACTIVE_LOW = os.environ.get("IR_ACTIVE_LOW", "true").lower() == "true"

I2C_BUS = 1
PCA9548A_ADDRESS = 0x70
DS3231_ADDRESS = 0x68
LCD_ADDRESSES = (0x27, 0x3F)
SPI_BUS = 0
SPI_DEVICE = 0

RFID_SS_PINS = (8, 7, 5, 6, 13, 16)
RFID_RESET_PIN = 25
IR_PINS = (14, 15, 18, 20, 21, 26)
KEYPAD_ROWS = (4, 17, 27, 22)
KEYPAD_COLUMNS = (23, 24, 12)
KEYPAD_LAYOUT = (("1", "2", "3"), ("4", "5", "6"), ("7", "8", "9"), ("*", "0", "#"))


class HardwareApi:
    def post(self, payload):
        if not API_BASE_URL or not HARDWARE_API_KEY:
            raise RuntimeError("Set SMARTPARK_API_URL and HARDWARE_API_KEY in /etc/smartpark/hardware.env")
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Hardware-Key": HARDWARE_API_KEY},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"API {error.code}: {body}") from error


class Pca9548a:
    def __init__(self, bus):
        self.bus = bus

    def select(self, channel):
        self.bus.write_byte(PCA9548A_ADDRESS, 1 << channel)


class Lcd1602:
    ENABLE = 0x04
    REGISTER_SELECT = 0x01
    BACKLIGHT = 0x08

    def __init__(self, bus, mux, address):
        self.bus = bus
        self.mux = mux
        self.address = address
        self.initialise()

    def _write(self, value):
        self.mux.select(1)
        self.bus.write_byte(self.address, value | self.BACKLIGHT)

    def _nibble(self, value):
        self._write(value)
        self._write(value | self.ENABLE)
        time.sleep(0.0005)
        self._write(value & ~self.ENABLE)

    def _send(self, value, mode=0):
        self._nibble((value & 0xF0) | mode)
        self._nibble(((value << 4) & 0xF0) | mode)

    def initialise(self):
        time.sleep(0.05)
        for command in (0x33, 0x32, 0x28, 0x0C, 0x06, 0x01):
            self._send(command)
        time.sleep(0.005)
        self.message("SmartPark Pi", "Starting...")

    def message(self, first_line, second_line=""):
        self._send(0x01)
        time.sleep(0.002)
        self._send(0x80)
        for character in first_line[:16].ljust(16):
            self._send(ord(character), self.REGISTER_SELECT)
        self._send(0xC0)
        for character in second_line[:16].ljust(16):
            self._send(ord(character), self.REGISTER_SELECT)


class Mfrc522Reader:
    COMMAND = 0x01
    COMM_I_EN = 0x02
    COMM_IRQ = 0x04
    ERROR = 0x06
    FIFO_DATA = 0x09
    FIFO_LEVEL = 0x0A
    CONTROL = 0x0C
    BIT_FRAMING = 0x0D
    MODE = 0x11
    TX_CONTROL = 0x14
    TX_ASK = 0x15
    TMODE = 0x2A
    TPRESCALER = 0x2B
    TRELOAD_H = 0x2C
    TRELOAD_L = 0x2D
    PCD_IDLE = 0x00
    PCD_TRANSCEIVE = 0x0C
    PCD_SOFTRESET = 0x0F
    PICC_REQA = 0x26
    PICC_ANTICOLL = 0x93

    def __init__(self, spi, ss_pin):
        self.spi = spi
        self.ss_pin = ss_pin
        GPIO.setup(ss_pin, GPIO.OUT, initial=GPIO.HIGH)
        self.reset()

    def _transfer(self, values):
        GPIO.output(self.ss_pin, GPIO.LOW)
        response = self.spi.xfer2(values)
        GPIO.output(self.ss_pin, GPIO.HIGH)
        return response

    def write(self, register, value):
        self._transfer([((register << 1) & 0x7E), value])

    def read(self, register):
        return self._transfer([0x80 | ((register << 1) & 0x7E), 0])[1]

    def set_bit_mask(self, register, mask):
        self.write(register, self.read(register) | mask)

    def clear_bit_mask(self, register, mask):
        self.write(register, self.read(register) & ~mask)

    def reset(self):
        self.write(self.COMMAND, self.PCD_SOFTRESET)
        time.sleep(0.05)
        self.write(self.TMODE, 0x8D)
        self.write(self.TPRESCALER, 0x3E)
        self.write(self.TRELOAD_L, 30)
        self.write(self.TRELOAD_H, 0)
        self.write(self.TX_ASK, 0x40)
        self.write(self.MODE, 0x3D)
        self.set_bit_mask(self.TX_CONTROL, 0x03)

    def to_card(self, command, send_data):
        irq_enable, wait_irq = (0x77, 0x30) if command == self.PCD_TRANSCEIVE else (0x12, 0x10)
        self.write(self.COMM_I_EN, irq_enable | 0x80)
        self.clear_bit_mask(self.COMM_IRQ, 0x80)
        self.set_bit_mask(self.FIFO_LEVEL, 0x80)
        self.write(self.COMMAND, self.PCD_IDLE)
        for value in send_data:
            self.write(self.FIFO_DATA, value)
        self.write(self.COMMAND, command)
        if command == self.PCD_TRANSCEIVE:
            self.set_bit_mask(self.BIT_FRAMING, 0x80)
        for _ in range(2000):
            irq = self.read(self.COMM_IRQ)
            if irq & wait_irq or irq & 0x01:
                break
        self.clear_bit_mask(self.BIT_FRAMING, 0x80)
        if self.read(self.ERROR) & 0x1B or not (irq & wait_irq):
            return None
        count = self.read(self.FIFO_LEVEL)
        return [self.read(self.FIFO_DATA) for _ in range(count)]

    def uid(self):
        self.write(self.BIT_FRAMING, 0x07)
        if not self.to_card(self.PCD_TRANSCEIVE, [self.PICC_REQA]):
            return None
        self.write(self.BIT_FRAMING, 0)
        result = self.to_card(self.PCD_TRANSCEIVE, [self.PICC_ANTICOLL, 0x20])
        if not result or len(result) != 5 or (result[0] ^ result[1] ^ result[2] ^ result[3]) != result[4]:
            return None
        return " ".join(f"{value:02X}" for value in result[:4])


class Keypad:
    def __init__(self):
        for row in KEYPAD_ROWS:
            GPIO.setup(row, GPIO.OUT, initial=GPIO.HIGH)
        for column in KEYPAD_COLUMNS:
            GPIO.setup(column, GPIO.IN, pull_up_down=GPIO.PUD_UP)

    def read(self):
        for row_index, row_pin in enumerate(KEYPAD_ROWS):
            GPIO.output(row_pin, GPIO.LOW)
            time.sleep(0.001)
            for column_index, column_pin in enumerate(KEYPAD_COLUMNS):
                if GPIO.input(column_pin) == GPIO.LOW:
                    GPIO.output(row_pin, GPIO.HIGH)
                    return KEYPAD_LAYOUT[row_index][column_index]
            GPIO.output(row_pin, GPIO.HIGH)
        return None


class SmartParkPrototype:
    def __init__(self):
        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(RFID_RESET_PIN, GPIO.OUT, initial=GPIO.HIGH)
        for pin in IR_PINS:
            GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
        self.api = HardwareApi()
        self.bus = SMBus(I2C_BUS)
        self.mux = Pca9548a(self.bus)
        self.components = {"PCA9548A I2C multiplexer": "checking", "DS3231 RTC": "checking", "16x2 I2C LCD": "checking", "4x3 keypad": "ready", "IR obstacle sensors": "6 input channels ready", "MFRC522 RFID readers": "6 SPI readers ready", "Green LEDs": "MCP23017 required"}
        self.lcd = self.configure_i2c_devices()
        self.keypad = Keypad()
        self.spi = spidev.SpiDev()
        self.spi.open(SPI_BUS, SPI_DEVICE)
        self.spi.max_speed_hz = 1_000_000
        self.spi.mode = 0
        self.spi.no_cs = True
        self.readers = [Mfrc522Reader(self.spi, pin) for pin in RFID_SS_PINS]
        self.hours = 1
        self.key_buffer = ""
        self.last_key = None
        self.last_scan = {}
        self.last_heartbeat = 0

    def configure_i2c_devices(self):
        try:
            self.mux.select(0)
            self.bus.read_byte_data(DS3231_ADDRESS, 0)
            self.components["PCA9548A I2C multiplexer"] = "online"
            self.components["DS3231 RTC"] = "detected on channel 0"
        except OSError:
            self.components["PCA9548A I2C multiplexer"] = "not detected"
            self.components["DS3231 RTC"] = "not detected"
        for address in LCD_ADDRESSES:
            try:
                self.mux.select(1)
                self.bus.read_byte(address)
                self.components["16x2 I2C LCD"] = f"detected at 0x{address:02X}"
                return Lcd1602(self.bus, self.mux, address)
            except OSError:
                continue
        self.components["16x2 I2C LCD"] = "not detected"
        return None

    def occupied_slots(self):
        active_value = GPIO.LOW if IR_ACTIVE_LOW else GPIO.HIGH
        return [GPIO.input(pin) == active_value for pin in IR_PINS]

    def display(self, first, second=""):
        if self.lcd:
            try:
                self.lcd.message(first, second)
            except OSError:
                self.components["16x2 I2C LCD"] = "communication error"

    def handle_keypad(self):
        key = self.keypad.read()
        if key == self.last_key:
            return
        self.last_key = key
        if not key:
            return
        if key == "*":
            self.key_buffer = ""
            self.display("Hours cleared", "Enter 1 to 12")
        elif key == "#":
            value = int(self.key_buffer or self.hours)
            self.hours = min(12, max(1, value))
            self.key_buffer = ""
            self.display("Parking duration", f"{self.hours} hour(s) set")
        elif key.isdigit() and len(self.key_buffer) < 2:
            self.key_buffer += key
            self.display("Set hours then #", self.key_buffer)

    def send_slot_event(self, slot, uid, occupied):
        event = "entry" if occupied else "exit"
        payload = {"event": event, "slot": slot, "uid": uid, "hours": self.hours, "source": "raspberry_pi_3b_plus"}
        try:
            status, response = self.api.post(payload)
            message = response.get("message", "Recorded")
            self.display(f"Slot {slot} {event}", message[:16])
            print(f"Slot {slot} {event}: HTTP {status} {message}")
        except RuntimeError as error:
            self.display("API error", str(error)[:16])
            print(error)

    def scan_rfid(self, occupancy):
        now = time.monotonic()
        for index, reader in enumerate(self.readers, start=1):
            uid = reader.uid()
            if not uid or now - self.last_scan.get((index, uid), 0) < 4:
                continue
            self.last_scan[(index, uid)] = now
            self.send_slot_event(index, uid, occupancy[index - 1])

    def heartbeat(self, occupancy):
        payload = {"event": "heartbeat", "source": "raspberry_pi_3b_plus", "firmware": "smartpark-pi-prototype/1.0", "keypadHours": self.hours, "timestamp": datetime.now().isoformat(), "components": self.components, "slots": [{"slot": index, "status": "occupied" if is_occupied else "free"} for index, is_occupied in enumerate(occupancy, start=1)]}
        try:
            self.api.post(payload)
        except RuntimeError as error:
            print(error)

    def run(self):
        self.display("SmartPark ready", "Tap card at slot")
        while True:
            self.handle_keypad()
            occupancy = self.occupied_slots()
            self.scan_rfid(occupancy)
            if time.monotonic() - self.last_heartbeat >= HEARTBEAT_SECONDS:
                self.last_heartbeat = time.monotonic()
                self.heartbeat(occupancy)
            time.sleep(0.06)

    def close(self):
        self.spi.close()
        self.bus.close()
        GPIO.cleanup()


if __name__ == "__main__":
    controller = None
    try:
        controller = SmartParkPrototype()
        controller.run()
    except KeyboardInterrupt:
        pass
    finally:
        if controller:
            controller.close()
