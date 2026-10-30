-- Verificação em duas etapas (opcional) do administrador central.
ALTER TABLE platform_admins ADD COLUMN totp_secret TEXT;
ALTER TABLE platform_admins ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_admins ADD COLUMN totp_last_step BIGINT;
