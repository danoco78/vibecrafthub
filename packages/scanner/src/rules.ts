import type { Finding, Severity } from '@vch/shared';

export type FileExtension = 'html' | 'js' | 'css' | 'json' | 'xml';

export interface RegexRule {
  id: string;
  severity: Severity;
  /** Extensiones de archivo donde aplica la regla */
  exts: FileExtension[];
  pattern: RegExp;
  message: string;
  fix: string;
}

/**
 * Reglas estáticas del MVP. Detectan patrones peligrosos por línea.
 * Falsos positivos posibles: se prefieren ante el costo de un falso negativo.
 * Cada hallazgo explica el problema y su corrección.
 */
export const RULES: RegexRule[] = [
  // ---------- critical ----------
  {
    id: 'no-eval',
    severity: 'critical',
    exts: ['js', 'html'],
    pattern: /\beval\s*\(/,
    message: 'Uso de eval(): ejecuta código arbitrario en tiempo de ejecución.',
    fix: 'Elimina eval(). Usa JSON.parse para datos, o mapeos explícitos de funciones.',
  },
  {
    id: 'no-new-function',
    severity: 'critical',
    exts: ['js', 'html'],
    pattern: /\bnew\s+Function\s*\(/,
    message: 'new Function() compila y ejecuta código arbitrario, equivalente a eval().',
    fix: 'Elimina new Function(). Define las funciones estáticamente.',
  },
  {
    id: 'secret-aws-access-key',
    severity: 'critical',
    exts: ['js', 'html', 'json', 'xml', 'css'],
    pattern: /AKIA[0-9A-Z]{16}/,
    message: 'Posible Access Key ID de AWS embebida en el código.',
    fix: 'Elimina la credencial del código. Rota la clave en AWS: queda comprometida.',
  },
  {
    id: 'secret-openai-key',
    severity: 'critical',
    exts: ['js', 'html', 'json', 'xml', 'css'],
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
    message: 'Posible API key (formato OpenAI) embebida en el código.',
    fix: 'Elimina la credencial del código y rotula la clave en su proveedor.',
  },
  {
    id: 'secret-github-token',
    severity: 'critical',
    exts: ['js', 'html', 'json', 'xml', 'css'],
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/,
    message: 'Posible token personal de GitHub embebido en el código.',
    fix: 'Elimina el token del código y revócalo en GitHub.',
  },
  {
    id: 'secret-private-key',
    severity: 'critical',
    exts: ['js', 'html', 'json', 'xml', 'css'],
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    message: 'Clave privada embebida en el bundle.',
    fix: 'Elimina la clave privada. Una clave en una app web es pública para quien la descargue.',
  },
  // ---------- high ----------
  {
    id: 'no-document-write',
    severity: 'high',
    exts: ['js', 'html'],
    pattern: /document\s*\.\s*write\s*\(/,
    message: 'document.write() permite inyección de HTML/arbitraria y bloquea el parser.',
    fix: 'Usa createElement/textContent o insertAdjacentHTML solo con contenido confiable.',
  },
  {
    id: 'no-innerhtml-assign',
    severity: 'high',
    exts: ['js', 'html'],
    pattern: /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/,
    message:
      'Asignación de innerHTML/outerHTML: si el dato viene del usuario o de una fuente externa es XSS.',
    fix: 'Usa textContent para texto. Si necesitas HTML, sanitiza con DOMPurify o construye nodos.',
  },
  {
    id: 'no-dynamic-import-url',
    severity: 'high',
    exts: ['js', 'html'],
    pattern: /import\s*\(\s*['"`]https?:/i,
    message: 'import() dinámico desde URL externa: carga código remoto no revisado.',
    fix: 'Empaqueta el módulo dentro del bundle e importa con ruta relativa.',
  },
  {
    id: 'no-remote-script',
    severity: 'high',
    exts: ['html'],
    pattern: /<script\b[^>]*\bsrc\s*=\s*["']https?:/i,
    message: 'Script desde dominio externo: ejecuta código que esta plataforma no revisó.',
    fix: 'Descarga la librería, inclúyela en el bundle y referénciala con ruta relativa.',
  },
  {
    id: 'no-remote-stylesheet',
    severity: 'high',
    exts: ['html'],
    pattern: /<link\b[^>]*\bhref\s*=\s*["']https?:/i,
    message: 'Hoja de estilos externa: puede filtrar datos y cambia sin control de versiones.',
    fix: 'Incluye el CSS en el bundle con ruta relativa.',
  },
  {
    id: 'no-remote-iframe',
    severity: 'high',
    exts: ['html'],
    pattern: /<iframe\b[^>]*\bsrc\s*=\s*["']https?:/i,
    message: 'iframe a sitio externo: expone a los usuarios a contenido no controlado.',
    fix: 'Elimina el iframe o solicita el dominio en el allowlist de la empresa.',
  },
  {
    id: 'no-websocket',
    severity: 'high',
    exts: ['js', 'html'],
    pattern: /\bnew\s+WebSocket\s*\(/,
    message: 'Conexión WebSocket: canal de red persistente no supervisado.',
    fix: 'Elimina el WebSocket o solicita el dominio en el allowlist de la empresa.',
  },
  {
    id: 'inline-script',
    severity: 'high',
    exts: ['html'],
    pattern: /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i,
    message:
      "Bloque <script> inline: la CSP de la plataforma (script-src 'self') impide su ejecución, así que esa lógica nunca corre.",
    fix: 'Mueve el código a un archivo .js y cárgalo con <script src="archivo.js">.',
  },
  // ---------- medium ----------
  {
    id: 'remote-fetch',
    severity: 'medium',
    exts: ['js', 'html'],
    pattern: /fetch\s*\(\s*['"`]https?:/i,
    message: 'fetch() a URL absoluta externa: envía datos fuera de la empresa.',
    fix: 'Usa archivos del propio bundle, o solicita el dominio en el allowlist.',
  },
  {
    id: 'xmlhttprequest',
    severity: 'medium',
    exts: ['js', 'html'],
    pattern: /\bnew\s+XMLHttpRequest\s*\(/,
    message: 'XMLHttpRequest a recursos externos: tráfico de red no autorizado.',
    fix: 'Usa archivos del propio bundle, o solicita el dominio en el allowlist.',
  },
  {
    id: 'no-service-worker',
    severity: 'medium',
    exts: ['js', 'html'],
    pattern: /navigator\s*\.\s*serviceWorker\s*\.\s*register/,
    message: 'Registro de service worker: persiste código entre sesiones y burla el control de versiones.',
    fix: 'Elimina el service worker. La plataforma sirve el bundle directamente.',
  },
  {
    id: 'remote-image',
    severity: 'medium',
    exts: ['html'],
    pattern: /<img\b[^>]*\bsrc\s*=\s*["']https?:/i,
    message: 'Imagen desde dominio externo: filtra IP y datos de rastreo de cada usuario.',
    fix: 'Incluye la imagen en el bundle.',
  },
  // ---------- low ----------
  {
    id: 'inline-event-handler',
    severity: 'low',
    exts: ['html'],
    pattern: /\son[a-z]+\s*=\s*["']/i,
    message: 'Manejador de eventos inline (onclick=…): dificulta la auditoría y la CSP estricta.',
    fix: 'Registra los eventos con addEventListener desde el JS del bundle.',
  },
  {
    id: 'target-blank-noopener',
    severity: 'low',
    exts: ['html'],
    pattern: /target\s*=\s*["']_blank["']/i,
    message: 'target="_blank" sin rel="noopener" permite tabnabbing.',
    fix: 'Agrega rel="noopener noreferrer" al enlace.',
  },
];
