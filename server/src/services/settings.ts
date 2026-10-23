import { DB, now, audit } from '../db.js';

/** Configurações comerciais. Valores ainda não confirmados pelos proprietários estão documentados em docs/PENDENCIAS.md. */
export const DEFAULT_SETTINGS = {
  /** Acréscimo fixo por venda a prazo (interpretação provisória), em centavos. */
  fiado_surcharge_cents: '50',
  /** SHARED = um código de caixa comum; INDIVIDUAL = cada usuário tem o seu. */
  cash_code_mode: 'SHARED',
  /** Dias de antecedência para alertar vencimento. */
  expiry_alert_days: '15',
  /** Prazo de reposição em dias (vazio = desconhecido). */
  restock_lead_time_days: '',
  /** Reserva de segurança em dias de venda (vazio = não configurada). */
  restock_safety_days: '',
  /** Meta de acuracidade do inventário (% por item), definida pelo administrador. Vazio = sem meta. */
  inventory_accuracy_target: '',
  /** Permitir venda com estoque insuficiente (estoque fica negativo e aparece nos alertas). */
  allow_negative_stock: 'true',
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
/** Chaves internas que nunca são enviadas ao navegador. */
const SECRET_KEYS = new Set(['shared_cash_code_hash', 'cancel_code_hash']);

export function getSetting(db: DB, key: SettingKey | 'shared_cash_code_hash' | 'cancel_code_hash'): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  return (DEFAULT_SETTINGS as Record<string, string>)[key] ?? '';
}

export function getNumberSetting(db: DB, key: SettingKey): number | null {
  const v = getSetting(db, key);
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function setSetting(db: DB, key: string, value: string, userId: number) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, value, userId, now());
  audit(db, userId, 'settings.update', 'settings', null, { key, value: SECRET_KEYS.has(key) ? '***' : value });
}

export function publicSettings(db: DB) {
  const out: Record<string, string> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) out[k] = getSetting(db, k);
  return { ...out, shared_cash_code_configured: getSetting(db, 'shared_cash_code_hash') !== '', cancel_code_configured: getSetting(db, 'cancel_code_hash') !== '' };
}
