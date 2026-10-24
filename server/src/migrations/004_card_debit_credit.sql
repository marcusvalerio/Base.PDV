-- Cartão passa a ser escolhido como débito ou crédito. O antigo "Cartão" fica inativo (preserva o histórico).
UPDATE payment_methods SET active = 0 WHERE code = 'CARTAO';
INSERT INTO payment_methods (code, name, kind, sort) VALUES
  ('CARTAO_DEBITO', 'Cartão de débito', 'CARD', 3),
  ('CARTAO_CREDITO', 'Cartão de crédito', 'CARD', 4)
ON CONFLICT (code) DO NOTHING;
UPDATE payment_methods SET sort = 5 WHERE code = 'FIADO';
