#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "SmartParking";
const char* WIFI_PASSWORD = "parking123";
const char* SERVER_URL = "http://192.168.4.1:3000/api/event";
const int SLOT_SENSORS[6] = {D1, D2, D3, D5, D6, D7};
unsigned long lastHeartbeat = 0;

bool postEvent(JsonDocument& payload) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client; HTTPClient http; http.begin(client, SERVER_URL); http.addHeader("Content-Type", "application/json");
  String body; serializeJson(payload, body); int code = http.POST(body); http.end(); return code >= 200 && code < 300;
}

void sendEntry(int slot, const String& uid, int hours) { StaticJsonDocument<192> event; event["event"]="entry"; event["slot"]=slot; event["uid"]=uid; event["hours"]=hours; postEvent(event); }
void sendExit(int slot, const String& uid) { StaticJsonDocument<160> event; event["event"]="exit"; event["slot"]=slot; event["uid"]=uid; postEvent(event); }
void sendRelease(int slot) { StaticJsonDocument<128> event; event["event"]="release"; event["slot"]=slot; event["reason"]="ir_timeout"; postEvent(event); }
void heartbeat() { StaticJsonDocument<192> event; event["event"]="status"; JsonArray slots = event.createNestedArray("slots"); for (int pin : SLOT_SENSORS) slots.add(digitalRead(pin) == LOW ? 1 : 0); postEvent(event); }
void setup() { Serial.begin(115200); for (int pin : SLOT_SENSORS) pinMode(pin, INPUT_PULLUP); WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); while (WiFi.status() != WL_CONNECTED) delay(500); }
void loop() { if (millis() - lastHeartbeat >= 5000) { lastHeartbeat = millis(); heartbeat(); } /* Invoke sendEntry/sendExit from your MFRC522 reader handler and sendRelease after a 10-second IR timeout. */ }
