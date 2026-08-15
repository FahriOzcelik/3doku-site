// netlify/functions/get-token.mjs
//
// PayTR iFrame API - Adım 1: iframe_token alma (Netlify Functions sürümü)
// Bu fonksiyon tarayıcıdan (sepetten) çağrılır, PayTR'a arka planda istek atar
// ve ödeme sayfasını açmak için gereken token'ı döner.
//
// Gerekli ortam değişkenleri (Netlify: Site settings > Environment variables):
//   PAYTR_MERCHANT_ID, PAYTR_MERCHANT_KEY, PAYTR_MERCHANT_SALT, PAYTR_TEST_MODE
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SITE_BASE_URL (örn: https://3doku.com.tr)
//
// Belgeler: https://dev.paytr.com/iframe-api

import crypto from 'node:crypto';

export default async (request, context) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const MERCHANT_ID = process.env.PAYTR_MERCHANT_ID;
  const MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY;
  const MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT;
  const TEST_MODE = process.env.PAYTR_TEST_MODE || '1';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://3doku.com.tr';

  if (!MERCHANT_ID || !MERCHANT_KEY || !MERCHANT_SALT || !SUPABASE_SERVICE_KEY) {
    return json({ error: 'Ödeme sistemi henüz yapılandırılmadı. Lütfen site yöneticisiyle iletişime geçin.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Geçersiz istek.' }, 400);
  }

  const customer = body.customer || {};
  const items = body.items || [];
  const total = Number(body.total);

  const name = (customer.name || '').trim();
  const phone = (customer.phone || '').trim();
  const email = (customer.email || '').trim();
  const address = (customer.address || '').trim();

  if (!name || !phone || !email || !address) {
    return json({ error: 'Müşteri bilgileri eksik.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Geçersiz e-posta adresi.' }, 400);
  }
  if (!total || total <= 0 || items.length === 0) {
    return json({ error: 'Sepet boş görünüyor.' }, 400);
  }

  const merchant_oid = 'SP' + Date.now() + Math.floor(Math.random() * 900 + 100);

  // 1) Siparişi Supabase'e "pending" durumda kaydet
  const orderRow = {
    merchant_oid,
    customer_name: name,
    customer_phone: phone,
    customer_email: email,
    customer_address: address,
    items,
    total_amount: total,
    status: 'pending',
    payment_provider: 'paytr'
  };

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(orderRow)
  });

  if (!insertRes.ok) {
    return json({ error: 'Sipariş kaydedilemedi. Lütfen tekrar deneyin.' }, 500);
  }

  // 2) PayTR sepet listesini hazırla: [ad, birim fiyat, adet]
  const paytrBasket = items.map((i) => [i.name, Number(i.price).toFixed(2), Number(i.qty)]);
  const user_basket = Buffer.from(JSON.stringify(paytrBasket)).toString('base64');

  const user_ip = request.headers.get('x-nf-client-connection-ip') || '0.0.0.0';
  const payment_amount = Math.round(total * 100); // kuruş
  const no_installment = 0;
  const max_installment = 0;
  const currency = 'TL';

  const hashStr = `${MERCHANT_ID}${user_ip}${merchant_oid}${email}${payment_amount}${user_basket}${no_installment}${max_installment}${currency}${TEST_MODE}`;
  const paytr_token = crypto
    .createHmac('sha256', MERCHANT_KEY)
    .update(hashStr + MERCHANT_SALT)
    .digest('base64');

  const form = new URLSearchParams({
    merchant_id: MERCHANT_ID,
    user_ip,
    merchant_oid,
    email,
    payment_amount: String(payment_amount),
    paytr_token,
    user_basket,
    debug_on: '1',
    no_installment: String(no_installment),
    max_installment: String(max_installment),
    user_name: name,
    user_address: address,
    user_phone: phone,
    merchant_ok_url: `${SITE_BASE_URL}/odeme-basarili.html`,
    merchant_fail_url: `${SITE_BASE_URL}/odeme-basarisiz.html`,
    timeout_limit: '30',
    currency,
    test_mode: TEST_MODE,
    lang: 'tr'
  });

  let paytrRes, paytrData;
  try {
    paytrRes = await fetch('https://www.paytr.com/odeme/api/get-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    paytrData = await paytrRes.json();
  } catch {
    return json({ error: 'PayTR bağlantı hatası.' }, 500);
  }

  if (!paytrData || paytrData.status !== 'success') {
    return json({ error: 'PayTR token alınamadı: ' + (paytrData?.reason || 'bilinmeyen hata') }, 500);
  }

  return json({ token: paytrData.token, merchant_oid });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
