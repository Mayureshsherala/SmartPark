const UAT_BASE_URL = 'https://api-preprod.phonepe.com/apis/pg-sandbox';
const PRODUCTION_BASE_URL = 'https://api.phonepe.com/apis/pg';
const PRODUCTION_AUTH_URL = 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';
let cachedToken = null;

const phonePeConfig = () => {
  const environment = String(process.env.PHONEPE_ENV || 'uat').toLowerCase();
  const baseUrl = (process.env.PHONEPE_BASE_URL || (environment === 'production' ? PRODUCTION_BASE_URL : UAT_BASE_URL)).replace(/\/+$/, '');
  return {
    environment,
    baseUrl,
    authUrl: (process.env.PHONEPE_AUTH_URL || (environment === 'production' ? PRODUCTION_AUTH_URL : `${baseUrl}/v1/oauth/token`)).replace(/\/+$/, ''),
    clientId: process.env.PHONEPE_CLIENT_ID,
    clientSecret: process.env.PHONEPE_CLIENT_SECRET,
    clientVersion: process.env.PHONEPE_CLIENT_VERSION || '1'
  };
};

export const isPhonePeConfigured = () => {
  const { clientId, clientSecret } = phonePeConfig();
  return Boolean(clientId && clientSecret);
};

const requestError = (message, status = 502) => Object.assign(new Error(message), { status });

const requestPhonePe = async (url, options) => {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw requestError('PhonePe UAT could not be reached. Check your internet connection and UAT configuration.');
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) throw requestError(body.message || body.code || 'PhonePe UAT rejected the request.', response.status >= 400 && response.status < 500 ? 400 : 502);
  return body;
};

const getAccessToken = async () => {
  const config = phonePeConfig();
  if (!isPhonePeConfigured()) throw requestError('PhonePe UAT is not configured. Add PHONEPE_CLIENT_ID and PHONEPE_CLIENT_SECRET to backend/.env.', 503);
  if (cachedToken?.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_version: config.clientVersion,
    client_secret: config.clientSecret,
    grant_type: 'client_credentials'
  });
  const response = await requestPhonePe(config.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.access_token) throw requestError('PhonePe UAT did not return an access token.');
  cachedToken = { token: response.access_token, expiresAt: Number(response.expires_at || 0) * 1000 || Date.now() + 10 * 60_000 };
  return cachedToken.token;
};

const authenticatedHeaders = async () => ({
  'Content-Type': 'application/json',
  Authorization: `O-Bearer ${await getAccessToken()}`
});

export const createPhonePeCheckout = async ({ merchantOrderId, amountPaisa, redirectUrl, phoneNumber, metaInfo }) => {
  const { baseUrl } = phonePeConfig();
  const payload = {
    merchantOrderId,
    amount: amountPaisa,
    expireAfter: 1200,
    paymentFlow: { type: 'PG_CHECKOUT', merchantUrls: { redirectUrl } },
    disablePaymentRetry: true,
    metaInfo
  };
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (digits.length >= 10) payload.prefillUserLoginDetails = { phoneNumber: digits.slice(-10) };
  return requestPhonePe(`${baseUrl}/checkout/v2/pay`, { method: 'POST', headers: await authenticatedHeaders(), body: JSON.stringify(payload) });
};

export const getPhonePeOrderStatus = async (merchantOrderId) => {
  const { baseUrl } = phonePeConfig();
  return requestPhonePe(`${baseUrl}/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`, { headers: await authenticatedHeaders() });
};
