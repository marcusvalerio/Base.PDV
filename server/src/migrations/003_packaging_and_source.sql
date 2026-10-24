-- Embalagem de compra: ex. "caixa" com 20 unidades, "barril" com 50 L (em milésimos da unidade do produto).
ALTER TABLE products ADD COLUMN pack_label TEXT;
ALTER TABLE products ADD COLUMN pack_size_milli BIGINT CHECK (pack_size_milli IS NULL OR pack_size_milli > 0);
-- Baixa em outro produto: ex. "Copo de Chopp 300ml" desconta 300 mL do "Chopp (barril)" a cada unidade vendida.
ALTER TABLE products ADD COLUMN stock_source_id INTEGER REFERENCES products(id);
ALTER TABLE products ADD COLUMN stock_source_qty_milli BIGINT CHECK (stock_source_qty_milli IS NULL OR stock_source_qty_milli > 0);
ALTER TABLE products ADD CONSTRAINT products_source_pair CHECK ((stock_source_id IS NULL) = (stock_source_qty_milli IS NULL));
ALTER TABLE products ADD CONSTRAINT products_source_not_self CHECK (stock_source_id IS NULL OR stock_source_id <> id);
-- Em cada item vendido, de qual produto (e quanto) saiu o estoque — permite estornar exatamente no cancelamento.
ALTER TABLE sale_items ADD COLUMN stock_product_id INTEGER REFERENCES products(id);
ALTER TABLE sale_items ADD COLUMN stock_qty_milli BIGINT;
