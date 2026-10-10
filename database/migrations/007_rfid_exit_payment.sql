ALTER TABLE parking_sessions
  ADD COLUMN exit_requested_at DATETIME NULL AFTER overstay_notified,
  ADD COLUMN exit_authorization_expires_at DATETIME NULL AFTER exit_requested_at;
