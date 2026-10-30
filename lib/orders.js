import { adminDb, FieldValue } from "./admin.js";
import { checkStatus, classify } from "./splashpay.js";

const MIN_RECHECK_MS = 3000;       // don't hammer SplashPay's status API
const NOT_FOUND_GRACE_MS = 120000; // timeout-on-initiate: allow time before giving up

/*
 * Grants the purchase inside a transaction. Idempotent: the purchase doc id is
 * the postId, and an already-COMPLETED order is never granted twice.
 * Paid betslip text lives in postSecrets/{id} (posts/{id}.content is empty).
 */
async function grantPurchase(reference, verified) {
  const orderRef = adminDb.doc(`orders/${reference}`);

  await adminDb.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data();

    if (order.status === "FLAGGED") return;

    const purchaseRef = adminDb.doc(`people/${order.uid}/purchases/${order.postId}`);
    const [postSnap, secretSnap, purchaseSnap] = await Promise.all([
      tx.get(adminDb.doc(`posts/${order.postId}`)),
      tx.get(adminDb.doc(`postSecrets/${order.postId}`)),
      tx.get(purchaseRef)
    ]);

    const post = postSnap.exists ? postSnap.data() : {};
    const content =
      (secretSnap.exists ? secretSnap.data().content || "" : "") || post.content || "";

    if (!purchaseSnap.exists) {
      tx.set(purchaseRef, {
        postId: order.postId,
        orderId: reference,
        amount: order.amount,
        currency: "TZS",
        title: post.title || "",
        content,
        platform: post.platform || "",
        provider: order.provider || "splashpay",
        status: "COMPLETED",
        paidAt: FieldValue.serverTimestamp()
      });
    } else if (!purchaseSnap.data().content && content) {
      tx.update(purchaseRef, { content });
    }

    if (order.status !== "COMPLETED") {
      tx.update(orderRef, {
        status: "COMPLETED",
        completedAt: FieldValue.serverTimestamp(),
        ...(verified || {})
      });
    }
  });
}

/*
 * Verifies an order against SplashPay's Payment Status API and updates it.
 * The ONLY path that grants access. Never trusts client or webhook-body status.
 *
 * opts.force: skip the recheck throttle and re-verify terminal FAILED orders
 *             (used by the webhook).
 * Returns { payment_status: COMPLETED|FAILED|PENDING, detail_status, ... }
 */
export async function settleOrder(reference, opts = {}) {
  const orderRef = adminDb.doc(`orders/${reference}`);
  const snap = await orderRef.get();
  if (!snap.exists) return { found: false };

  const order = snap.data();

  // Legacy (PalmPesa-era) orders: never call SplashPay; just repair if already paid.
  if (order.provider !== "splashpay") {
    if (order.status === "COMPLETED") await grantPurchase(reference);
    return {
      found: true, order,
      payment_status: order.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      detail_status: order.status === "COMPLETED" ? "success" : "legacy"
    };
  }

  if (order.status === "COMPLETED") {
    await grantPurchase(reference); // repairs a missing purchase / empty content, no-op otherwise
    return { found: true, order, payment_status: "COMPLETED", detail_status: "success" };
  }

  if (order.status === "FLAGGED") {
    return { found: true, order, payment_status: "PENDING", detail_status: "under_review" };
  }

  if (!opts.force) {
    if (order.status === "FAILED") {
      return { found: true, order, payment_status: "FAILED", detail_status: order.failureStatus || "failed" };
    }
    if (order.lastCheckedAtMs && Date.now() - order.lastCheckedAtMs < MIN_RECHECK_MS) {
      return { found: true, order, payment_status: "PENDING", detail_status: order.lastProviderStatus || "pending" };
    }
  }

  const result = await checkStatus(reference);
  const body = result.data || {};
  const p = body.data || {};

  // Reference unknown to SplashPay (e.g. initiate timed out and never arrived)
  if (body.code === "PAYMENT_NOT_FOUND") {
    const age = Date.now() - (order.createdAtMs || 0);
    if (!order.providerReference && age > NOT_FOUND_GRACE_MS) {
      await orderRef.update({ status: "FAILED", failureStatus: "failed", lastCheckedAtMs: Date.now() });
      return { found: true, order, payment_status: "FAILED", detail_status: "failed" };
    }
    return { found: true, order, payment_status: "PENDING", detail_status: "pending" };
  }

  if (!result.ok || body.status !== "success" || !p.status) {
    console.error("SplashPay status check unusable:", reference, result.httpStatus, body.code);
    const e = new Error("Status check failed");
    e.code = "STATUS_UNAVAILABLE";
    throw e;
  }

  // Match the transaction against our stored order
  const mismatch =
    p.reference !== reference ||
    String(p.currency || "").toUpperCase() !== "TZS" ||
    Number(p.amount) !== Number(order.amount);

  const mapped = classify(p.status);

  if (mapped === "COMPLETED" && mismatch) {
    console.error("PAYMENT MISMATCH — not granting:", {
      reference, expected: order.amount, got: p.amount, currency: p.currency, gotReference: p.reference
    });
    await orderRef.update({
      status: "FLAGGED",
      flagReason: "amount/currency/reference mismatch",
      lastCheckedAtMs: Date.now()
    });
    return { found: true, order, payment_status: "PENDING", detail_status: "under_review" };
  }

  const verified = {
    providerReference: p.provider_reference || null,
    provider: "splashpay",
    channel: p.channel || null,
    verifiedAt: FieldValue.serverTimestamp(),
    verifiedStatus: p.status
  };

  if (mapped === "COMPLETED") {
    await grantPurchase(reference, verified);
    return { found: true, order, payment_status: "COMPLETED", detail_status: "success" };
  }

  await orderRef.update({
    lastCheckedAtMs: Date.now(),
    lastProviderStatus: p.status,
    ...(p.provider_reference ? { providerReference: p.provider_reference } : {}),
    ...(mapped === "FAILED" ? { status: "FAILED", failureStatus: p.status } : {})
  });

  return { found: true, order, payment_status: mapped, detail_status: p.status };
}
