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
    // --- Renovación automática del token de Facebook (v1.4.0) ---
    // Con APP_ID + APP_SECRET, NEXO verifica la vigencia del token con
    // /debug_token y lo renueva solo (fb_exchange_token) cuando vence
    // dentro del margen. Sin estas dos, la renovación es manual.
    facebookAppId: process.env.FACEBOOK_APP_ID || '',
    facebookAppSecret: process.env.FACEBOOK_APP_SECRET || '',
    fbTokenRefreshMarginDays: parseInt(process.env.FB_TOKEN_REFRESH_MARGIN_DAYS || '7', 10) || 7,
    // --- Búsqueda semántica + Q&A (v1.5.0) ---
    // Sin OPENAI_API_KEY, /api/search y /api/qa responden 503 sin romper nada.
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    qaModel: process.env.QA_MODEL || 'gpt-4o-mini',
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
    // --- Webhook de WhatsApp multi-mensaje (v1.3.0, opt-in) ---
    // Sin estas variables el webhook existe pero rechaza eventos (401/403);
    // NEXO sigue funcionando como hub de extracción sin cambios.
    whatsappToken: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.PHONE_NUMBER_ID || '',
    verifyToken: process.env.VERIFY_TOKEN || '',
    appSecret: process.env.APP_SECRET || '',
    // Loteo multi-mensaje: pausa sin mensajes que dispara el flush, y tope
    // duro del lote (3 min por defecto). Ajustables por entorno.
    waBatchPauseMs: parseInt(process.env.WA_BATCH_PAUSE_MS || '30000', 10) || 30000,
    waBatchMaxMs: parseInt(process.env.WA_BATCH_MAX_MS || '180000', 10) || 180000,
    // --- Adaptador Momentos (v1.3.0) ---
    // Momentos es un artefacto privado sin API HTTP pública: NEXO prepara el
    // álbum y lo expone en /api/whatsapp/albums para importarlo desde el chat
    // con Muse (acciones createalbum/uploadmedia/addtextitem). Si algún día
    // Momentos expone un puente HTTP, se configura aquí.
    momentosBridgeUrl: (process.env.MOMENTOS_BRIDGE_URL || '').replace(/\/+$/, ''),
    momentosAuthor: process.env.MOMENTOS_AUTHOR || 'Miguel Susffalich',
  };
}

function fuentesActivas(c) {
  const f = [];
  if (c.facebookToken) f.push('facebook');
  if (c.facebookToken && c.instagramUserId) f.push('instagram');
  return f;
}

/** El webhook de WhatsApp está operativo solo con las 3 credenciales de Meta. */
function webhookEnabled(c) {
  return Boolean(c.whatsappToken && c.phoneNumberId && c.verifyToken && c.appSecret);
}

module.exports = { cfg, fuentesActivas, webhookEnabled };
