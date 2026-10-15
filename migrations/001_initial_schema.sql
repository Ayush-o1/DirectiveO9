-- DirectiveO9 Initial Relational Schema
-- Establishes participants, instruments, command journal, events, trades, and order projections

CREATE TABLE IF NOT EXISTS participants (
  participant_id INT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  api_key_hash VARCHAR(64) NOT NULL UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instruments (
  symbol VARCHAR(32) PRIMARY KEY,
  tick_size INT NOT NULL CHECK (tick_size > 0),
  lot_size INT NOT NULL CHECK (lot_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commands (
  seq BIGINT PRIMARY KEY,
  command_type VARCHAR(20) NOT NULL,
  participant_id INT NOT NULL REFERENCES participants(participant_id),
  client_order_id VARCHAR(64) NULL,
  symbol VARCHAR(32) NULL REFERENCES instruments(symbol),
  side VARCHAR(10) NULL,
  price INT NULL CHECK (price IS NULL OR price > 0),
  quantity INT NULL CHECK (quantity IS NULL OR quantity > 0),
  order_id BIGINT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  response_status INT NOT NULL DEFAULT 200,
  response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_participant_client_order_id UNIQUE (participant_id, client_order_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id BIGSERIAL PRIMARY KEY,
  seq BIGINT NOT NULL REFERENCES commands(seq),
  event_type VARCHAR(30) NOT NULL,
  order_id BIGINT NULL,
  participant_id INT NULL,
  payload JSONB NOT NULL,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  trade_id BIGINT PRIMARY KEY,
  seq BIGINT NOT NULL REFERENCES commands(seq),
  symbol VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
  price INT NOT NULL CHECK (price > 0),
  quantity INT NOT NULL CHECK (quantity > 0),
  maker_order_id BIGINT NOT NULL,
  taker_order_id BIGINT NOT NULL,
  maker_participant_id INT NOT NULL REFERENCES participants(participant_id),
  taker_participant_id INT NOT NULL REFERENCES participants(participant_id),
  taker_side VARCHAR(10) NOT NULL,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  order_id BIGINT PRIMARY KEY,
  participant_id INT NOT NULL REFERENCES participants(participant_id),
  symbol VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
  side VARCHAR(10) NOT NULL,
  price INT NULL CHECK (price IS NULL OR price > 0),
  original_qty INT NOT NULL CHECK (original_qty > 0),
  remaining_qty INT NOT NULL CHECK (remaining_qty >= 0),
  filled_qty INT NOT NULL CHECK (filled_qty >= 0),
  state VARCHAR(20) NOT NULL,
  seq BIGINT NOT NULL REFERENCES commands(seq),
  ts BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_orders_symbol_state ON orders(symbol, state);
CREATE INDEX IF NOT EXISTS idx_orders_participant ON orders(participant_id);
