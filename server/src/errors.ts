export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const badRequest = (msg: string, code = 'INVALID') => new AppError(400, code, msg);
export const notFound = (msg = 'Registro não encontrado.') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, code = 'CONFLICT') => new AppError(409, code, msg);
export const forbidden = (msg = 'Você não tem permissão para esta operação.') => new AppError(403, 'FORBIDDEN', msg);
export const unauthorized = (msg = 'Faça login para continuar.') => new AppError(401, 'UNAUTHORIZED', msg);
