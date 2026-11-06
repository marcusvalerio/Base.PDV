-- Planos: Essencial (padrão) e Pro (Essencial + Pix com confirmação automática pelo Mercado Pago).
ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'essencial' CHECK (plan IN ('essencial','pro'));

-- Conta do Mercado Pago conectada por cada estabelecimento (o dinheiro cai na conta DELE).
-- Fica na plataforma (fora do schema do estabelecimento): nunca entra em backup nem é lida pelas telas.
-- Tokens guardados criptografados (AES-256-GCM).
CREATE TABLE mp_accounts (
  tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mp_user_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  connected_by INTEGER,
  connected_at TEXT NOT NULL
);
