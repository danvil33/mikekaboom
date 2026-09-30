import { adminDb, adminAuth, FieldValue } from "../lib/admin.js";

const SUCCESS = new Set([
  "COMPLETED", "COMPLETE", "SUCCESS", "SUCCESSFUL",
  "PAID", "SETTLED", "APPROVED", "CONFIRMED"
]);

const FAILURE = new Set([
  "FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED",
  "DECLINED", "ERROR", "EXPIRED", "TIMEOUT", "INSUFFICIENT_FUNDS"
]);

const PENDING = new Set([
  "PENDING", "PROCESSING", "INITIATED", "WAITING", "QUEUED", "IN_PROGRESS"
]);

/*
 * Never ask PalmPesa about the same order more often than this.
 * Too many requests from a datacenter IP can trigger their bot filter.
 */
const MIN_CHECK_GAP_MS = 8000;

/*
 * Orders older than this that still say PENDING are marked ABANDONED
 * so we stop asking PalmPesa about them forever.
 */
const ABANDON_AFTER_MS = 3 * 24 * 3600 * 1000;

function normalizeStatus(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function classify(raw) {
  const s = normalizeStatus(raw);
  if (SUCCESS.has(s)) return "COMPLETED";
  if (FAILURE.has(s)) return "FAILED";
  return "PENDING";
}

/*
 * Ask PalmPesa. Throws if unreachable or blocked so the order
 * stays PENDING and gets retried later.
 */
async function fetchPalmStatus(orderId) {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  let response, raw;

  try {

    response = await fetch("https://palmpesa.drmlelwa.co.tz/api/order-status", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.PALMPESA_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; MikekaBoom/1.0)"
      },
      body: JSON.stringify({ order_id: orderId }),
      signal: controller.signal
    });

    raw = await response.text();

  } finally {

    clearTimeout(timer);

  }

  const looksLikeHtml = String(raw).trim().startsWith("<");

  console.log("PalmPesa status HTTP:", response.status, "order:", orderId, "html:", looksLikeHtml);

  if (looksLikeHtml) {
    const err = new Error("PalmPesa returned an HTML page (HTTP " + response.status + "), likely a firewall or captcha block.");
    err.blocked = true;
    throw err;
  }

  console.log("PalmPesa status response:", String(raw).slice(0, 500));

  if (!response.ok) {
    throw new Error("PalmPesa status HTTP " + response.status + ": " + String(raw).slice(0, 200));
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw_response: raw };
  }

  const payment =
    Array.isArray(data?.data) ? data.data[0]
    : Array.isArray(data?.data?.data) ? data.data.data[0]
    : null;

  const rawStatus =
    payment?.payment_status ||
    payment?.status ||
    data?.payment_status ||
    data?.status ||
    data?.data?.payment_status ||
    "";

  const normalized = normalizeStatus(rawStatus);

  if (
    !SUCCESS.has(normalized) &&
    !FAILURE.has(normalized) &&
    !PENDING.has(normalized)
  ) {
    console.warn(
      "UNRECOGNISED PalmPesa status:",
      JSON.stringify(rawStatus),
      "order:",
      orderId
    );
  }

  return {
    status: classify(rawStatus),
    message: payment?.message || data?.message || ""
  };
}

/*
 * Idempotent: safe to run from polling, sync and retries at the same time.
 * Uses the content snapshotted into the order at payment time.
 */
async function grantPurchase(orderId) {

  const orderRef = adminDb.doc(`orders/${orderId}`);

  await adminDb.runTransaction(async (tx) => {

    const orderSnap = await tx.get(orderRef);

    if (!orderSnap.exists) {
      console.error("COMPLETED payment but no order record:", orderId);
      return;
    }

    const order = orderSnap.data();

    if (order.status === "COMPLETED") {
      return;
    }

    let { title, content, platform } = order;

    if (!content) {

      const secretSnap = await tx.get(adminDb.doc(`postSecrets/${order.postId}`));
      const postSnap = await tx.get(adminDb.doc(`posts/${order.postId}`));

      const post = postSnap.exists ? postSnap.data() : {};

      content = secretSnap.exists
        ? (secretSnap.data().content || "")
        : (post.content || "");

      title = title || post.title || "";
      platform = platform || post.platform || "";

    }

    tx.set(adminDb.doc(`people/${order.uid}/purchases/${order.postId}`), {
      postId: order.postId,
      orderId,
      amount: order.amount,
      title: title || "",
      content: content || "",
      platform: platform || "",
      status: "COMPLETED",
      paidAt: FieldValue.serverTimestamp()
    });

    tx.update(orderRef, {
      status: "COMPLETED",
      completedAt: FieldValue.serverTimestamp()
    });

  });

}

/*
 * Check PalmPesa (throttled) and update our records.
 */
async function settleOrder(orderId) {

  const ref = adminDb.doc(`orders/${orderId}`);
  const snap = await ref.get();

  if (!snap.exists) {
    return { status: "PENDING", message: "" };
  }

  const order = snap.data();

  if (order.status === "COMPLETED") {
    return { status: "COMPLETED", message: "" };
  }

  if (order.status === "FAILED") {
    return { status: "FAILED", message: "" };
  }

  const created = order.createdAt?.toMillis?.() || 0;

  if (created && Date.now() - created > ABANDON_AFTER_MS) {
    await ref.update({
      status: "ABANDONED",
      abandonedAt: FieldValue.serverTimestamp()
    }).catch(() => {});
    return { status: "FAILED", message: "This order expired." };
  }

  const last = order.lastCheckedAt?.toMillis?.() || 0;

  if (Date.now() - last < MIN_CHECK_GAP_MS) {
    return { status: "PENDING", message: "" };
  }

  await ref.update({ lastCheckedAt: FieldValue.serverTimestamp() }).catch(() => {});

  const result = await fetchPalmStatus(orderId);

  if (result.status === "COMPLETED") {

    await grantPurchase(orderId);

  } else if (result.status === "FAILED") {

    await ref.update({
      status: "FAILED",
      failedAt: FieldValue.serverTimestamp()
    }).catch(() => {});

  }

  return result;

}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  let uid;

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    uid = (await adminAuth.verifyIdToken(token)).uid;
  } catch {
    return res.status(401).json({
      success: false,
      message: "Please sign in again."
    });
  }

  try {

    const { order_id, sync } = req.body || {};

    /*
     * SYNC MODE: settle this user's pending orders.
     */
    if (sync) {

      const snap = await adminDb.collection("orders")
        .where("uid", "==", uid)
        .where("status", "==", "PENDING")
        .limit(5)
        .get();

      await Promise.allSettled(snap.docs.map((d) => settleOrder(d.id)));

      return res.json({
        success: true,
        checked: snap.size
      });

    }

    /*
     * SINGLE ORDER MODE
     */
    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id is required"
      });
    }

    const orderSnap = await adminDb.doc(`orders/${order_id}`).get();

    if (!orderSnap.exists || orderSnap.data().uid !== uid) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    if (orderSnap.data().status === "COMPLETED") {
      return res.json({
        success: true,
        order_id,
        payment_status: "COMPLETED"
      });
    }

    const result = await settleOrder(order_id);

    return res.json({
      success: true,
      order_id,
      payment_status: result.status,
      message: result.message || null
    });

  } catch (error) {

    console.error("Order status error:", error.message);

    if (error.blocked) {
      return res.status(503).json({
        success: false,
        message: "Payment service is busy. Your payment is safe and will unlock automatically once confirmed."
      });
    }

    return res.status(502).json({
      success: false,
      message: "Could not check payment yet. Retrying."
    });

  }

}
