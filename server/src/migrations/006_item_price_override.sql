-- Preço alterado na hora da venda (só para aquela venda; o cadastro não muda).
-- list_price_cents: preço de cadastro quando o item foi vendido por outro valor (NULL = sem alteração).
ALTER TABLE sale_items ADD COLUMN list_price_cents INTEGER;
-- Motivo informado ao alterar o preço (exigido junto com o código de cancelamento).
ALTER TABLE sales ADD COLUMN price_note TEXT;
