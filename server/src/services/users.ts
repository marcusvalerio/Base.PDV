import { DB, now, audit } from '../db.js';
import { hashSecret, verifySecret, newToken, sha256 } from '../security.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';

export type Role = 'ADMIN' | 'OPERADOR';
export interface SessionUser { id: number; name: string; username: string; role: Role; superAdmin: boolean }

const SESSION_HOURS = 12;

export function validatePassword(p: string) {
  if (p.length < 8) throw badRequest('A senha deve ter pelo menos 8 caracteres.');
}

function isSuper(db: DB, id: number | null) {
  return id != null && !!(db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(id) as any)?.is_super_admin;
}

export function createUser(db: DB, input: { name: string; username: string; password: string; role: Role; superAdmin?: boolean }, actorId: number | null) {
  // actorId null = script de linha de comando (instalação).
  if (input.superAdmin && actorId !== null && !isSuper(db, actorId)) throw forbidden('Só o super administrador pode criar outro super administrador.');
  validatePassword(input.password);
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username);
  if (exists) throw conflict('Já existe um usuário com este login.');
  const t = now();
  const sup = input.superAdmin ? 1 : 0;
  const r = db.prepare('INSERT INTO users (name, username, password_hash, role, is_super_admin, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(input.name.trim(), input.username.trim(), hashSecret(input.password), sup ? 'ADMIN' : input.role, sup, t, t);
  audit(db, actorId, 'user.create', 'user', r.lastInsertRowid, { username: input.username, role: input.role, superAdmin: !!sup });
  return Number(r.lastInsertRowid);
}

export function updateUser(db: DB, id: number, patch: { name?: string; role?: Role; active?: boolean; password?: string }, actorId: number) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!u) throw notFound('Usuário não encontrado.');
  if (u.is_super_admin && !isSuper(db, actorId)) throw forbidden('Somente o super administrador pode alterar esta conta.');
  if (u.is_super_admin && patch.role && patch.role !== 'ADMIN') throw badRequest('O super administrador deve ter perfil de administrador.');
  if (id === actorId && (patch.active === false || (patch.role && patch.role !== 'ADMIN'))) {
    throw badRequest('Você não pode bloquear ou rebaixar a sua própria conta.');
  }
  if (patch.password !== undefined) validatePassword(patch.password);
  db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(
    patch.name?.trim() ?? u.name, patch.role ?? u.role, patch.active === undefined ? u.active : patch.active ? 1 : 0,
    patch.password ? hashSecret(patch.password) : u.password_hash, now(), id,
  );
  // Bloqueio, troca de perfil ou de senha revogam as sessões ativas.
  if (patch.active === false || patch.role || patch.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(db, actorId, 'user.update', 'user', id, { ...patch, password: patch.password ? '***' : undefined });
}

export function setUserCashCode(db: DB, id: number, code: string | null, actorId: number) {
  if ((db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(id) as any)?.is_super_admin && !isSuper(db, actorId)) throw forbidden();
  if (code !== null && !/^\d{4,8}$/.test(code)) throw badRequest('O código deve ter de 4 a 8 dígitos.');
  db.prepare('UPDATE users SET cash_code_hash = ?, updated_at = ? WHERE id = ?').run(code ? hashSecret(code) : null, now(), id);
  audit(db, actorId, 'user.cash_code', 'user', id, { set: code !== null });
}

export function listUsers(db: DB) {
  return db.prepare('SELECT id, name, username, role, is_super_admin, active, cash_code_hash IS NOT NULL AS has_cash_code, created_at FROM users ORDER BY name').all();
}

export function login(db: DB, username: string, password: string): { token: string; user: SessionUser } | null {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as any;
  // Executa a verificação mesmo se o usuário não existir para reduzir diferença de tempo.
  const ok = verifySecret(password, u?.password_hash ?? 'scrypt$AAAA$AAAA');
  if (!u || !ok || !u.active) {
    audit(db, u?.id ?? null, 'auth.login_failed', 'user', u?.id ?? null, { username });
    return null;
  }
  const token = newToken();
  const t = new Date();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), u.id, t.toISOString(), new Date(t.getTime() + SESSION_HOURS * 3600e3).toISOString());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t.toISOString());
  audit(db, u.id, 'auth.login', 'user', u.id);
  return { token, user: { id: u.id, name: u.name, username: u.username, role: u.role, superAdmin: !!u.is_super_admin } };
}

export function userFromToken(db: DB, token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.name, u.username, u.role, u.is_super_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  ).get(sha256(token), now()) as any;
  return row ? { id: row.id, name: row.name, username: row.username, role: row.role, superAdmin: !!row.is_super_admin } : null;
}

export function logout(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
