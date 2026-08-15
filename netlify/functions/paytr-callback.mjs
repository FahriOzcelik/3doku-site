// netlify/functions/paytr-callback.mjs
//
// PayTR iFrame API - Adım 3: Bildirim (notify_url) — Netlify Functions sürümü
//
// PayTR, ödeme sonucunu bu adrese arka planda POST isteğiyle bildirir.
// Gerçek sipariş onayı BURADA yapılır.
//
// PayTR Mağaza Paneli'nde "Bildirim URL" alanına şunu yazın:
//   https://3doku.com.tr/.netlify/functions/paytr-callback
//
// Gerekli ortam değişkenleri: PAYTR_MERCHANT_KEY, PAYTR_MERCHANT_SALT,
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

import crypto from 'node:crypto';

export default async (request, context) => {
  const MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY;
  const MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const form = await request.formData();
  const merchant_oid = form.get('merchant_oid');
  const status = form.get('status');
  const total_amount = form.get('total_amount');
  const hash = form.get('hash');

  if (!merchant_oid || !hash) {
    return new Response('PARAM YOK', { status: 400 });
  }

  const hashStr = `${merchant_oid}${MERCHANT_SALT}${status}${total_amount}`;
  const calculatedHash = crypto.createHmac('sha256', MERCHANT_KEY).update(hashStr).digest('base64');

  if (calculatedHash !== hash) {
    return new Response('HASH UYUŞMUYOR', { status: 400 });
  }

  const newStatus = status === 'success' ? 'paid' : 'failed';

  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?merchant_oid=eq.${encodeURIComponent(merchant_oid)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
    }
  );

  if (!updateRes.ok) {
    // Sessizce günlüğe yaz, yine de PayTR'a OK de (aksi halde sonsuza kadar tekrar dener).
    console.error(`PAYTR CALLBACK: Supabase güncellemesi başarısız. merchant_oid=${merchant_oid} status=${newStatus} http=${updateRes.status}`);
  }

  // PayTR'a "aldım, tekrar göndermene gerek yok" de.
  return new Response('OK', { status: 200 });
};
