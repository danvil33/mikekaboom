import { adminDb, adminAuth, FieldValue } from "../lib/admin.js";
import {
  initiateMobileMoney,
  normalizeTanzaniaPhone,
  newReference,
  SplashPayConfigError
} from "../lib/splashpay.js";
import { settleOrder } from "../lib/orders.js";

const REUSE_PENDING_MS =
  (Number(process.env.PENDING_REUSE_MINUTES) || 10) * 60 * 1000;

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {

    // WHO IS PAYING — verified Firebase token
    const idToken = (req.headers.authorization || "").replace("Bearer ", "");
    let uid;
    try {
      uid = (await adminAuth.verifyIdToken(idToken)).uid;
    } catch {
      return res.status(401).json({ success: false, message: "Please sign in again." });
    }

    const { name, email, phone, postId } = req.body || {};

    if (!name || !email || !phone || !postId || typeof postId !== "string" || postId.includes("/")) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    // PRICE FROM DATABASE ONLY
    const postSnap = await adminDb.doc(`posts/${postId}`).get();
    if (!postSnap.exists) {
      return res.status(404).json({ success: false, message: "Betslip not found or expired." });
    }
    const post = postSnap.data();

    const expiresMs = post.expiresAt?.toMillis ? post.expiresAt.toMillis() : null;
    if (expiresMs && expiresMs <= Date.now()) {
      return res.status(404).json({ success: false, message: "Betslip not found or expired." });
    }

    const amount = Number(post.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid betslip price." });
    }

    const phoneIntl = normalizeTanzaniaPhone(phone);
    if (!phoneIntl) {
      return res.status(400).json({
        success: false,
        message: "Invalid Tanzania phone number. Use 07XXXXXXXX, 06XXXXXXXX or +255XXXXXXXXX."
      });
    }

    // ALREADY PURCHASED — never charge twice
    const purchased = await adminDb.doc(`people/${uid}/purchases/${postId}`).get();
    if (purchased.exists && purchased.data().status === "COMPLETED") {
      return res.status(409).json({
        success: false,
        message: "You already own this betslip. Open My Betslip to view it."
      });
    }

    // RECENT PENDING ORDER FOR THE SAME USER + BETSLIP — reuse instead of charging again
    const pendingSnap = await adminDb
      .collection("orders")
      .where("uid", "==", uid)
      .where("postId", "==", postId)
      .where("status", "==", "PENDING")
      .get();

    for (const d of pendingSnap.docs) {
      const o = d.data();
      if (o.provider === "splashpay" && Date.now() - (o.createdAtMs || 0) < REUSE_PENDING_MS) {
        try {
          const r = await settleOrder(d.id);
          if (r.payment_status === "COMPLETED") {
            return res.status(409).json({
              success: false,
              message: "Your payment was already received. Open My Betslip to view it."
            });
          }
          if (r.payment_status === "PENDING") {
            return res.json({
              success: true,
              reused: true,
              order_id: d.id,
              reference: d.id,
              message: "A payment for this betslip is already waiting for your PIN."
            });
          }
          // FAILED -> fall through and create a new order
        } catch {
          // Can't verify the old order right now: safest is to keep waiting on it
          return res.json({
            success: true, reused: true, order_id: d.id, reference: d.id,
            message: "A payment for this betslip is already waiting for your PIN."
          });
        }
      }
    }

    // CREATE THE ORDER FIRST (so a fast webhook always finds it)
    const reference = newReference();

    await adminDb.doc(`orders/${reference}`).set({
      uid,
      postId,
      amount,
      currency: "TZS",
      phone: phoneIntl,
      provider: "splashpay",
      status: "PENDING",
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now()
    });

    // INITIATE WITH SPLASHPAY (from the backend)
    let result;
    try {
      result = await initiateMobileMoney({
        amount,
        reference,
        phone: phoneIntl,
        customerName: String(name).trim(),
        customerEmail: String(email).trim()
      });
    } catch (err) {

      if (err instanceof SplashPayConfigError) {
        console.error("SplashPay not configured");
        await adminDb.doc(`orders/${reference}`).update({ status: "FAILED", failureStatus: "failed" });
        return res.status(503).json({
          success: false,
          message: "Payments are temporarily unavailable. Please try again later."
        });
      }

      // Timeout / network error: outcome unknown. Keep the order PENDING; the
      // webhook or status check will resolve it (or it fails after a grace period).
      const timedOut = err.name === "AbortError";
      console.error("SplashPay initiate error:", timedOut ? "timeout" : err.message);
      return res.status(202).json({
        success: true,
        unconfirmed: true,
        order_id: reference,
        reference,
        message: "We are waiting for the payment provider. If a PIN prompt appears, enter it."
      });
    }

    const body = result.data || {};
    const accepted =
      result.ok && body.status === "success" && body.data?.reference === reference;

    if (!accepted) {
      console.error("SplashPay rejected payment:", reference, result.httpStatus, body.code, body.message);
      await adminDb.doc(`orders/${reference}`).update({
        status: "FAILED",
        failureStatus: "failed",
        failureCode: body.code || null
      });

      const userMessage =
        result.httpStatus === 401 || result.httpStatus === 403
          ? "Payments are temporarily unavailable. Please try again later."
          : result.httpStatus === 429
          ? "Too many attempts. Please wait a moment and try again."
          : body.code === "INVALID_REQUEST"
          ? "Payment details were not accepted. Check your phone number and try again."
          : "Unable to start the payment. Please try again.";

      return res.status(result.ok ? 502 : (result.httpStatus >= 500 ? 502 : 400)).json({
        success: false,
        message: userMessage
      });
    }

    await adminDb.doc(`orders/${reference}`).update({
      providerReference: body.data.provider_reference || null,
      fee: body.data.fee ?? null,
      requestId: body.request_id || null
    });

    return res.json({
      success: true,
      order_id: reference,
      reference
    });

  } catch (error) {
    console.error("Payment server error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while starting the payment."
    });
  }
}
