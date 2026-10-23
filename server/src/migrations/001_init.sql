-- Convenções:
--  * Valores monetários em centavos (INTEGER) — sem ponto flutuante.
--  * Quantidades em milésimos da unidade do produto (qty_milli):
--      UN/PCT: 1000 = 1 unidade | L: 1000 = 1 litro (1 = 1 mL) | KG: 1000 = 1 kg.
--  * Datas em ISO-8601 UTC; conversão para o fuso do estabelecimento na aplicação.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','OPERADOR')),
  active INTEGER NOT NULL DEFAULT 1,
  cash_code_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  internal_code TEXT UNIQUE,
  barcode TEXT UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  unit TEXT NOT NULL CHECK (unit IN ('UN','PCT','L','KG')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  stock_milli INTEGER NOT NULL DEFAULT 0,
  min_stock_milli INTEGER NOT NULL DEFAULT 0,
  track_expiry INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE product_history (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  user_id INTEGER REFERENCES users(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  at TEXT NOT NULL
);

CREATE TABLE payment_methods (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CASH','PIX','CARD','CREDIT')),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE cash_registers (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  opening_float_cents INTEGER NOT NULL CHECK (opening_float_cents >= 0),
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  expected_cash_cents INTEGER,
  counted_cash_cents INTEGER,
  summary_json TEXT
);
-- No máximo um caixa aberto por vez (estabelecimento com um único caixa).
CREATE UNIQUE INDEX uq_one_open_register ON cash_registers(status) WHERE status = 'OPEN';

CREATE TABLE cash_movements (
  id INTEGER PRIMARY KEY,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  type TEXT NOT NULL CHECK (type IN ('SUPRIMENTO','SANGRIA')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);

CREATE TABLE tabs (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX uq_open_tab_label ON tabs(label) WHERE status = 'OPEN';

CREATE TABLE tab_people (
  id INTEGER PRIMARY KEY,
  tab_id INTEGER NOT NULL REFERENCES tabs(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  customer_id INTEGER REFERENCES customers(id),
  tab_id INTEGER REFERENCES tabs(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','CANCELLED')),
  subtotal_cents INTEGER NOT NULL,
  surcharge_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  received_cents INTEGER,
  change_cents INTEGER,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT
);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_register ON sales(register_id);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER,
  total_cents INTEGER NOT NULL,
  tab_person_id INTEGER REFERENCES tab_people(id)
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

CREATE TABLE tab_items (
  id INTEGER PRIMARY KEY,
  tab_id INTEGER NOT NULL REFERENCES tabs(id),
  person_id INTEGER NOT NULL REFERENCES tab_people(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','VOIDED')),
  sale_id INTEGER REFERENCES sales(id),
  added_by INTEGER NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_tab_items_tab ON tab_items(tab_id);

CREATE TABLE receivables (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),
  original_cents INTEGER NOT NULL,
  surcharge_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('OPEN','PAID','CANCELLED')),
  created_at TEXT NOT NULL,
  CHECK (paid_cents >= 0 AND paid_cents <= total_cents)
);
CREATE INDEX idx_receivables_customer ON receivables(customer_id);

CREATE TABLE receivable_payments (
  id INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  register_id INTEGER NOT NULL REFERENCES cash_registers(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  user_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);

CREATE TABLE receivable_allocations (
  payment_id INTEGER NOT NULL REFERENCES receivable_payments(id),
  receivable_id INTEGER NOT NULL REFERENCES receivables(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (payment_id, receivable_id)
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK (type IN ('SALE','SALE_CANCEL','ENTRY','ADJUST','LOSS','INVENTORY')),
  qty_milli INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  unit_cost_cents INTEGER,
  reason TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE INDEX idx_stock_mov_product ON stock_movements(product_id, at);

CREATE TABLE stock_lots (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  expiry_date TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  movement_id INTEGER REFERENCES stock_movements(id),
  created_at TEXT NOT NULL
);

CREATE TABLE inventory_counts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE inventory_count_items (
  count_id INTEGER NOT NULL REFERENCES inventory_counts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  system_milli INTEGER NOT NULL,
  counted_milli INTEGER NOT NULL,
  diff_milli INTEGER NOT NULL,
  PRIMARY KEY (count_id, product_id)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details_json TEXT,
  at TEXT NOT NULL
);

INSERT INTO payment_methods (code, name, kind, sort) VALUES
  ('DINHEIRO','Dinheiro','CASH',1),
  ('PIX','Pix','PIX',2),
  ('CARTAO','Cartão','CARD',3),
  ('FIADO','A prazo (fiado)','CREDIT',4);

INSERT INTO categories (name) VALUES
  ('Cervejas'),('Refrigerantes'),('Chopp'),('Bebidas em geral'),('Biscoitos'),('Alimentos'),('Mercearia');
