'use strict';
const { query } = require('../db/pool');

async function getSetting(key, fallback) {
  const r = await query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}

module.exports = async function settingsRoutes(ctx, D) {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/settings/public') {
    return D({ registration_open: await getSetting('registration_open', true) });
  }

  if (method === 'PATCH' && path === '/api/admin/settings') {
    if (typeof ctx.body.registration_open === 'boolean') {
      await query(
        `INSERT INTO settings (key, value) VALUES ('registration_open', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(ctx.body.registration_open)]
      );
    }
    return D({ ok: true, registration_open: await getSetting('registration_open', true) });
  }
};

module.exports.getSetting = getSetting;
