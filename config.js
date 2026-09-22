'use strict';

/**
 * Configuración de NEXO desde variables de entorno.
 * Ningún valor real vive en el código: todo se inyecta por entorno.
 */

function cfg() {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    dryRun: /^true$/i.test(process.env.DRY_RUN || ''),
    databaseUrl: process.env.DATABASE_URL || '',
    // Fuentes
    facebookToken: process.env.FACEBOOK_USER_TOKEN || '',
    instagramUserId: process.env.INSTAGRAM_USER_ID || '',
    // IA (opcional: sin esto se usan heurísticas locales)
    openaiKey: process.env.OPENAI_API_KEY || '',
    // JEV / TypeSafe AI (opcional: decisiones rápidas; sin key, la IA usa heurísticas)
    jev: {
      key: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '',
      model: process.env.JEV_MODEL || 'jev-latest',
      baseUrl: (process.env.JEV_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    },
    // Adaptador Legado Vivo (opcional: sin esto la entrega queda pendiente)
    legadoUrl: (process.env.LEGADO_VIVO_URL || '').replace(/\/+$/, ''),
    legadoKey: process.env.BRIDGE_API_KEY || '',
    legadoFamilyId: parseInt(process.env.LEGADO_FAMILY_ID || '', 10) || 0,
    mediaDir: process.env.MEDIA_DIR || '',
  };
}

function fuentesActivas(c) {
  const f = [];
  if (c.facebookToken) f.push('facebook');
  if (c.facebookToken && c.instagramUserId) f.push('instagram');
  return f;
}

module.exports = { cfg, fuentesActivas };
