-- Migration: Create lore_signals table for tracking LORE webhook signal history
-- This enables distinguishing first signals from transitions (e.g., first Fastest = buy, Gamble→Fastest = already holding)

CREATE TABLE IF NOT EXISTS lore_signals (
  id SERIAL PRIMARY KEY,
  mint_address VARCHAR(44) NOT NULL,
  event VARCHAR(50) NOT NULL,
  box_type VARCHAR(50),
  symbol VARCHAR(20),
  name VARCHAR(200),
  market_cap_usd NUMERIC,
  price_usd NUMERIC,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB,
  
  -- Indexes for fast lookups
  CONSTRAINT mint_address_format CHECK (mint_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);

CREATE INDEX IF NOT EXISTS idx_lore_signals_mint ON lore_signals(mint_address);
CREATE INDEX IF NOT EXISTS idx_lore_signals_received_at ON lore_signals(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_lore_signals_event ON lore_signals(event);
CREATE INDEX IF NOT EXISTS idx_lore_signals_box_type ON lore_signals(box_type);

-- Composite index for common query pattern: get history for a mint
CREATE INDEX IF NOT EXISTS idx_lore_signals_mint_received ON lore_signals(mint_address, received_at DESC);

COMMENT ON TABLE lore_signals IS 'History of all LORE webhook signals received, enabling detection of first signals vs transitions';
COMMENT ON COLUMN lore_signals.mint_address IS 'Solana token mint address (Base58)';
COMMENT ON COLUMN lore_signals.event IS 'LORE event type: token_featured, token_moved, token_reentry, token_removed, candidates_updated';
COMMENT ON COLUMN lore_signals.box_type IS 'Featured box type: Gamble, Fastest, Highest, or null';
COMMENT ON COLUMN lore_signals.metadata IS 'Additional signal data as JSON (e.g., volume, holders, etc.)';
