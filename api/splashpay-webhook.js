import { adminDb } from "../lib/admin.js";
import { verifyWebhookSignature, SplashPayConfigError } from "../lib/splashpay.js";
import { settleOrder } from "../lib/orders.js";

/*
 * The signature is computed over the EXACT raw body, so body parsing is
 * disabled for this function (Vercel honours config.api.bodyParser = false).
 */
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  // If a platform already parsed the body, fall back to re-serialising it
  // (weaker: key order/escaping may differ from what was signed).
  if (req.body !== undefined && req.readableEnded) {
    console.warn("Webhook body was pre-parsed; signature check uses JSON.stringify fallback.");
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(400).json({ success: false });
  }

  // 1. AUTHENTICITY (fail closed)
  let valid;
  try {
    valid = verifyWebhookSignature(
      raw,
      req.headers["x-splashpay-timestamp"],
      req.headers["x-splashpay-signature"]
    );
  } catch (err) {
    if (err instanceof SplashPayConfigError) {
      console.error("Webhook secret missing — rejecting webhook.");
      return res.status(500).json({ success: false });
    }
    valid = false;
  }

  if (!valid) {
    console.warn("Rejected webhook with invalid signature");
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).json({ success: false });
  }

  const reference = payload?.data?.reference;

  // Not one of ours / malformed: acknowledge so SplashPay stops retrying.
  if (!reference || typeof reference !== "string" || reference.includes("/")) {
    return res.status(200).json({ success: true });
  }

  try {

    const exists = (await adminDb.doc(`orders/${reference}`).get()).exists;
    if (!exists) {
      console.warn("Webhook for unknown reference:", reference);
      return res.status(200).json({ success: true });
    }

    // 2. Don't trust the body's status: re-verify with SplashPay's Status API,
    //    match amount/currency/reference to our order, then (idempotently) grant.
    //    Duplicate deliveries are harmless: a COMPLETED order is a no-op.
    await settleOrder(reference, { force: true });

    return res.status(200).json({ success: true });

  } catch (error) {
    // Non-2xx => SplashPay retries per its documented schedule.
    console.error("Webhook processing failed:", reference, error.message);
    return res.status(500).json({ success: false });
  }
}
