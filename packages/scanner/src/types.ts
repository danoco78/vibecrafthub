export interface BundleEntry {
  /** Ruta normalizada con separador "/" relativa a la raíz del bundle */
  path: string;
  /** Contenido del archivo (los directorios vienen con data vacía) */
  data: Buffer;
  isDir: boolean;
}

export interface ScanContext {
  entries: BundleEntry[];
}
