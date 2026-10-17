import { hash, verify } from '@node-rs/argon2';

/** Argon2id con parámetros por defecto de @node-rs/argon2 (64 MB, 3 iteraciones). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  return verify(hashValue, password);
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (password.length > 128) return 'La contraseña no puede superar 128 caracteres.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'La contraseña debe combinar letras y números.';
  }
  return null;
}
