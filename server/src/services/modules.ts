import { DB, audit } from '../db.js';
import { forbidden, badRequest } from '../errors.js';
import { getSetting, setSetting } from './settings.js';

/** Módulos que só ficam disponíveis quando o super administrador libera. */
export const MODULES = {
  mesas: 'Mesas e comandas',
  fiado: 'Fiado e clientes',
  estoque: 'Estoque (entradas, ajustes, alertas)',
  inventario: 'Inventário e acuracidade',
  analise: 'Análise comercial',
  reposicao: 'Lista de reposição',
  auditoria: 'Auditoria',
} as const;
export type ModuleKey = keyof typeof MODULES;

export function getModules(db: DB): Record<ModuleKey, boolean> {
  let saved: Record<string, boolean> = {};
  try { saved = JSON.parse(getSetting(db, 'modules' as any) || '{}'); } catch { /* padrão */ }
  return Object.fromEntries((Object.keys(MODULES) as ModuleKey[]).map((k) => [k, saved[k] === true])) as Record<ModuleKey, boolean>;
}

export const isModuleOn = (db: DB, k: ModuleKey) => getModules(db)[k];

export function requireModule(db: DB, k: ModuleKey) {
  if (!isModuleOn(db, k)) throw forbidden(`O módulo "${MODULES[k]}" não está liberado. Fale com o super administrador.`);
}

export function setModules(db: DB, patch: Partial<Record<string, boolean>>, userId: number) {
  const cur = getModules(db);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in MODULES)) throw badRequest(`Módulo desconhecido: ${k}`);
    cur[k as ModuleKey] = !!v;
  }
  setSetting(db, 'modules', JSON.stringify(cur), userId);
  audit(db, userId, 'modules.update', 'settings', null, patch);
  return cur;
}
