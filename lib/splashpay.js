import crypto from "crypto";

/*
 * SplashPay client helpers.
 * Endpoints, headers, fields and status values below are taken from
 * https://docs.splashpay.co.tz (Authentication, Mobile Money, Payment Status, Webhooks).
 */

const BASE_URL = process.env.SPLASHPAY_BASE_URL || "https://api.splashpay.co.tz/api/v1";
const TIMEOUT_MS = 25000;

export class SplashPayConfigError extends Error {}

function credentials() {
  const key = process.env.SPLASHPAY_KEY;
  const secret = process.env.SPLASHPAY_SECRET;
  if (!key || !secret) {
    throw new SplashPayConfigError("SplashPay API credentials are not configured.");
  }
  return { key, secret };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function call(path, body, idempotencyKey) {
  const { key, secret } = credentials();
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-API-KEY": key,
    "X-API-SECRET": secret
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw_response: text }; }
  return { httpStatus: response.status, ok: response.ok, data };
}

/* POST /payments/mobile-money */
export function initiateMobileMoney({ amount, reference, phone, customerName, customerEmail }) {
  return call(
    "/payments/mobile-money",
    {
      amount,
      currency: "TZS",
      reference,
      phone,
      customer_name: customerName,
      customer_email: customerEmail
    },
    reference // same key only when retrying the same request
  );
}

/* POST /payments/check-status */
export function checkStatus(reference) {
  return call("/payments/check-status", { reference });
}

/*
 * Documented statuses: pending, processing, success, failed, cancelled, expired.
 * Anything else is treated as PENDING (never as paid).
 */
export function classify(rawStatus) {
  const s = String(rawStatus || "").trim().toLowerCase();
  if (s === "success") return "COMPLETED";
  if (s === "failed" || s === "cancelled" || s === "expired") return "FAILED";
  return "PENDING";
}

export function normalizeTanzaniaPhone(value) {
  let p = String(value || "").trim().replace(/[\s-]+/g, "");
  if (p.startsWith("+255")) p = p.substring(1);
  if (p.startsWith("0")) p = "255" + p.substring(1);
  return /^255\d{9}$/.test(p) ? p : null;
}

export function newReference() {
  return "MB-" + crypto.randomBytes(9).toString("hex").toUpperCase();
}

/*
 * Webhook signature (docs): HMAC_SHA256(timestamp + "." + body, WEBHOOK_SECRET),
 * hex digest, compared with X-SPLASHPAY-SIGNATURE.
 */
export function verifyWebhookSignature(rawBody, timestamp, signature) {
  const secret = process.env.SPLASHPAY_WEBHOOK_SECRET;
  if (!secret) throw new SplashPayConfigError("Webhook secret is not configured.");
  if (!timestamp || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature).trim(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
