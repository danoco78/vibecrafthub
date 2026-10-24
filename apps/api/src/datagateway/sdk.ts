/**
 * SDK del data gateway, servido por la plataforma en /db/sdk.js (mismo origen
 * que la app: el navegador lo carga sin relajar la CSP). No va en el zip.
 *
 * Contrato (ver docs/design-v0.2.md):
 *   VCH.db.all(sql, params?)  → { rows, truncated }
 *   VCH.db.get(sql, params?)  → fila o null
 *   VCH.db.run(sql, params?)  → { changes, lastInsertRowid }
 * Los errores lanzan Error con .code estable (VCH_DB_*).
 */
export const SDK_JS = `'use strict';
(function () {
  if (window.VCH && window.VCH.db) return;

  // Dev sin gateway: la app se sirve en /bundles/{slug}/ → el gateway está en
  // esa misma base de ruta. Producción ({slug}.apps.*): raíz del subdominio.
  var m = (location.origin + location.pathname).match(/\\/bundles\\/([a-z0-9-]+)\\//);
  var BASE = m ? '/bundles/' + m[1] + '/db' : '/db';

  function call(sql, params, mode) {
    return fetch(BASE + '/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sql, params: params || [], mode: mode }),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!res.ok) {
            var code = body && body.error && body.error.code ? body.error.code : 'VCH_DB_INTERNAL';
            var message =
              body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
            var err = new Error(message);
            err.code = code;
            err.status = res.status;
            throw err;
          }
          return body;
        });
    });
  }

  window.VCH = window.VCH || {};
  window.VCH.db = {
    all: function (sql, params) {
      return call(sql, params, 'all');
    },
    get: function (sql, params) {
      return call(sql, params, 'get').then(function (r) {
        return r.row !== undefined ? r.row : null;
      });
    },
    run: function (sql, params) {
      return call(sql, params, 'run');
    },
  };
})();
`;
