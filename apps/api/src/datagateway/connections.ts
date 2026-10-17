import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Registro de conexiones SQLite del data gateway: un archivo por app
 * (DATA_DIR/{slug}/app.db), apertura lazy, modo WAL y cierre explícito
 * para reset/descarga/eliminación. Proceso único del API → Map en memoria.
 */
export class AppDbRegistry {
  private conns = new Map<string, DatabaseSync>();

  constructor(private readonly dataDir: string) {}

  /** Ruta del archivo de BD de una app. El slug SIEMPRE viene validado por SLUG_RE. */
  dbPath(slug: string): string {
    return path.join(this.dataDir, slug, 'app.db');
  }

  /** Abre (o reutiliza) la conexión de la app. Crea el archivo si no existe. */
  open(slug: string, opts: { busyTimeoutMs: number }): DatabaseSync {
    let conn = this.conns.get(slug);
    if (!conn) {
      const dir = path.join(this.dataDir, slug);
      mkdirSync(dir, { recursive: true });
      conn = new DatabaseSync(this.dbPath(slug));
      conn.exec(`PRAGMA journal_mode = WAL`);
      conn.exec(`PRAGMA foreign_keys = ON`);
      this.conns.set(slug, conn);
    }
    // Se aplica siempre: el admin puede cambiar el timeout sin reiniciar.
    conn.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs}`);
    return conn;
  }

  get(slug: string): DatabaseSync | undefined {
    return this.conns.get(slug);
  }

  /** Cierra la conexión si estaba abierta (SQLite hace checkpoint al cerrar). */
  close(slug: string): void {
    const conn = this.conns.get(slug);
    if (conn) {
      try {
        conn.close();
      } catch {
        // ya cerrada
      }
      this.conns.delete(slug);
    }
  }

  /** Elimina por completo los datos de la app (BD + WAL + SHM). */
  async removeData(slug: string): Promise<void> {
    this.close(slug);
    await fs.rm(path.join(this.dataDir, slug), { recursive: true, force: true });
  }

  /** Tamaño en disco (archivo + WAL). Aproximado: para el panel, no para enforcement. */
  async diskSizeBytes(slug: string): Promise<number> {
    const base = this.dbPath(slug);
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        const st = await fs.stat(base + suffix);
        total += st.size;
      } catch {
        // archivo inexistente
      }
    }
    return total;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    appDb: AppDbRegistry;
  }
}
