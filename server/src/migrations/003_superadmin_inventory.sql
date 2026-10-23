-- Super administrador: libera módulos e gerencia administradores.
ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0;

-- Sessões de inventário (contagem física) com cálculo de acuracidade.
CREATE TABLE inventory_sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('FULL','CATEGORY','PARTIAL')),
  category_id INTEGER REFERENCES categories(id),
  blind INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('OPEN','FINISHED','CANCELLED')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  finished_by INTEGER REFERENCES users(id),
  finished_at TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  item_accuracy REAL,
  value_accuracy REAL,
  summary_json TEXT
);

CREATE TABLE inventory_session_items (
  session_id INTEGER NOT NULL REFERENCES inventory_sessions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  counted_milli INTEGER,
  -- Saldo do sistema no momento da contagem: vendas posteriores não geram falsa divergência.
  system_at_count_milli INTEGER,
  unit_cost_cents INTEGER,
  counted_by INTEGER REFERENCES users(id),
  counted_at TEXT,
  PRIMARY KEY (session_id, product_id)
);
