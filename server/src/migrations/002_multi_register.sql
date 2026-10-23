-- Vários caixas abertos ao mesmo tempo: no máximo um caixa aberto por usuário.
DROP INDEX uq_one_open_register;
CREATE UNIQUE INDEX uq_open_register_per_user ON cash_registers(opened_by) WHERE status = 'OPEN';
