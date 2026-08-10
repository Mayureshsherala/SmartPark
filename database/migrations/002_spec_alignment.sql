ALTER TABLE users MODIFY status ENUM('pending_rfid','active','blocked') DEFAULT 'pending_rfid';
ALTER TABLE users ADD COLUMN vehicle_color VARCHAR(50) NULL AFTER vehicle_type, ADD COLUMN vehicle_model VARCHAR(100) NULL AFTER vehicle_color;
ALTER TABLE slots MODIFY status ENUM('free','occupied','reserved','maintenance') DEFAULT 'free';
ALTER TABLE slots ADD COLUMN label VARCHAR(30) NULL AFTER slot_id;
ALTER TABLE bookings ADD COLUMN booking_expires_at DATETIME NULL AFTER expected_arrival, ADD COLUMN notes TEXT NULL AFTER duration_hours;
ALTER TABLE parking_sessions ADD COLUMN source ENUM('walk_in','pre_booked') DEFAULT 'walk_in' AFTER vehicle_number, ADD COLUMN overstay_notified BOOLEAN DEFAULT FALSE AFTER source;
CREATE TABLE IF NOT EXISTS hardware_events (event_id BIGINT AUTO_INCREMENT PRIMARY KEY,event_type VARCHAR(50) NOT NULL,slot_number INT NULL,uid VARCHAR(40),payload JSON NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,INDEX idx_hardware_events_created_at (created_at),INDEX idx_hardware_events_slot (slot_number));
