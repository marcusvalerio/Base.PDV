import { DB, now, audit, isUniqueViolation } from '../db.js';
import { hashSecret, verifySecret, newToken, sha256 } from '../security.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';

export type Role = 'ADMIN' | 'OPERADOR';
export interface SessionUser { id: number; name: string; username: string; role: Role }

const SESSION_HOURS = 12;

export function validatePassword(p: string) {
  if (p.length < 8) throw badRequest('A senha deve ter pelo menos 8 caracteres.');
}

/** Cria usuário no estabelecimento atual. O login precisa estar reservado no diretório global (platform.reserveUsername). */
export async function createUser(db: DB, input: { name: string; username: string; password: string; role: Role }, actorId: number | null) {
  validatePassword(input.password);
  const t = now();
  try {
    const r = await db.one<{ id: number }>(
      'INSERT INTO users (name, username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [input.name.trim(), input.username.trim(), hashSecret(input.password), input.role, t, t],
    );
    await audit(db, actorId, 'user.create', 'user', r!.id, { username: input.username, role: input.role });
    return r!.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Já existe um usuário com este login.');
    throw e;
  }
}

export async function updateUser(db: DB, id: number, patch: { name?: string; role?: Role; active?: boolean; password?: string }, actorId: number) {
  const u = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw notFound('Usuário não encontrado.');
  if (id === actorId && (patch.active === false || (patch.role && patch.role !== 'ADMIN'))) {
    throw badRequest('Você não pode bloquear ou rebaixar a sua própria conta.');
  }
  if (patch.password !== undefined) validatePassword(patch.password);
  await db.run('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ?, updated_at = ? WHERE id = ?', [
    patch.name?.trim() ?? u.name, patch.role ?? u.role, patch.active === undefined ? u.active : patch.active ? 1 : 0,
    patch.password ? hashSecret(patch.password) : u.password_hash, now(), id,
  ]);
  // Bloqueio, troca de perfil ou de senha revogam as sessões ativas.
  if (patch.active === false || patch.role || patch.password) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  await audit(db, actorId, 'user.update', 'user', id, { ...patch, password: patch.password ? '***' : undefined });
}

export async function setUserCashCode(db: DB, id: number, code: string | null, actorId: number) {
  if (code !== null && !/^\d{4,8}$/.test(code)) throw badRequest('O código deve ter de 4 a 8 dígitos.');
  await db.run('UPDATE users SET cash_code_hash = ?, updated_at = ? WHERE id = ?', [code ? hashSecret(code) : null, now(), id]);
  await audit(db, actorId, 'user.cash_code', 'user', id, { set: code !== null });
}

export function listUsers(db: DB) {
  return db.all('SELECT id, name, username, role, active, cash_code_hash IS NOT NULL AS has_cash_code, created_at FROM users ORDER BY name');
}

export async function login(db: DB, username: string, password: string): Promise<{ token: string; user: SessionUser } | null> {
  const u = await db.one('SELECT * FROM users WHERE lower(username) = lower(?)', [username.trim()]);
  // Executa a verificação mesmo se o usuário não existir para reduzir diferença de tempo.
  const ok = verifySecret(password, u?.password_hash ?? 'scrypt$AAAA$AAAA');
  if (!u || !ok || !u.active) {
    await audit(db, u?.id ?? null, 'auth.login_failed', 'user', u?.id ?? null, { username });
    return null;
  }
  const token = newToken();
  const t = new Date();
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    [sha256(token), u.id, t.toISOString(), new Date(t.getTime() + SESSION_HOURS * 3600e3).toISOString()]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [t.toISOString()]);
  await audit(db, u.id, 'auth.login', 'user', u.id);
  return { token, user: { id: u.id, name: u.name, username: u.username, role: u.role } };
}

export async function userFromToken(db: DB, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await db.one(
    `SELECT u.id, u.name, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    [sha256(token), now()],
  );
  return row ? { id: row.id, name: row.name, username: row.username, role: row.role } : null;
}

export async function logout(db: DB, token: string) {
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}
