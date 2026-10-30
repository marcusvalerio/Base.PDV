-- Limite de tentativas (login, cadastro) guardado no banco: vale para todas as instâncias do servidor, inclusive na Vercel.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  blocked_until TEXT
);
