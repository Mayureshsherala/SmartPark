ALTER TABLE bookings
  ADD COLUMN arrived_at DATETIME NULL AFTER vehicle_number;
