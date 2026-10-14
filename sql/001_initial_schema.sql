-- Salem Star Speaker Schema
-- Compatible with MySQL 8.x, MariaDB 10.x, and SQLite 3

CREATE TABLE IF NOT EXISTS event_config (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  tagline VARCHAR(150) NOT NULL,
  event_date DATE NOT NULL,
  registration_deadline VARCHAR(50) NOT NULL,
  venue_name VARCHAR(150) NOT NULL,
  venue_city VARCHAR(100) NOT NULL,
  is_registration_open INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  slug VARCHAR(20) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  form_label VARCHAR(100) NOT NULL,
  min_age INT NOT NULL,
  max_age INT NOT NULL,
  fee_paise INT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  is_active INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS registrations (
  id VARCHAR(36) PRIMARY KEY,
  reference VARCHAR(30) NOT NULL UNIQUE,
  category_slug VARCHAR(20) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL,
  phone VARCHAR(25) NOT NULL,
  dob DATE NOT NULL,
  age_on_contest INT NOT NULL,
  occupation VARCHAR(50) NOT NULL,
  city VARCHAR(100) NOT NULL,
  guardian_name VARCHAR(100) NULL,
  guardian_phone VARCHAR(25) NULL,
  amount_paise INT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(30) NOT NULL DEFAULT 'AWAITING_PAYMENT',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (category_slug) REFERENCES categories(slug)
);

CREATE INDEX IF NOT EXISTS idx_reg_reference ON registrations(reference);
CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(email);
CREATE INDEX IF NOT EXISTS idx_reg_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_reg_created_at ON registrations(created_at);

CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(36) PRIMARY KEY,
  registration_id VARCHAR(36) NOT NULL,
  registration_reference VARCHAR(30) NOT NULL,
  razorpay_order_id VARCHAR(50) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(50) NULL UNIQUE,
  razorpay_signature VARCHAR(128) NULL,
  amount_paise INT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(30) NOT NULL DEFAULT 'CREATED',
  failure_reason TEXT NULL,
  idempotency_key VARCHAR(100) NULL UNIQUE,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES registrations(id)
);

CREATE INDEX IF NOT EXISTS idx_pay_order_id ON payments(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_pay_payment_id ON payments(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_pay_reg_ref ON payments(registration_reference);
CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id VARCHAR(36) PRIMARY KEY,
  registration_id VARCHAR(36) NOT NULL,
  registration_reference VARCHAR(30) NOT NULL,
  recipient_email VARCHAR(150) NOT NULL,
  email_type VARCHAR(50) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at DATETIME NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES registrations(id)
);

CREATE INDEX IF NOT EXISTS idx_email_reg_id ON email_deliveries(registration_id);
CREATE INDEX IF NOT EXISTS idx_email_recipient ON email_deliveries(recipient_email);
CREATE INDEX IF NOT EXISTS idx_email_status ON email_deliveries(status);
