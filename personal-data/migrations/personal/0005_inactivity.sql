CREATE INDEX accounts_inactivity_ready ON accounts(blocked, last_active_at, user_id);
