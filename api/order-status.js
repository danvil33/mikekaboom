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
 * Ask PalmPesa for the real status.
 * Throws if PalmPesa is unreachable, so the order stays PENDING
 * and gets retried on the next check.
 */
async function fetchPalmStatus(orderId) {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let response, raw;

  try {

    response = await fetch("https://palmpesa.drmlelwa.co.tz/api/order-status", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.PALMPESA_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ order_id: orderId }),
      signal: controller.signal
    });

    raw = await response.text();

  } finally {

    clearTimeout(timer);

  }

  console.log("PalmPesa status HTTP:", response.status, "order:", orderId);
  console.log("PalmPesa status response:", raw);

  if (!response.ok) {
    throw new Error("PalmPesa status HTTP " + response.status);
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
 * The purchase gets the content that was snapshotted into the order at
 * payment time, so it still works if the post was deleted or expired.
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

    /*
     * Fallback for orders created before content was snapshotted.
     * All reads happen before any writes (Firestore transaction rule).
     */
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
 * Check PalmPesa and update our records.
 */
async function settleOrder(orderId) {

  const result = await fetchPalmStatus(orderId);

  if (result.status === "COMPLETED") {

    await grantPurchase(orderId);

  } else if (result.status === "FAILED") {

    const ref = adminDb.doc(`orders/${orderId}`);
    const snap = await ref.get();

    if (snap.exists && snap.data().status === "PENDING") {
      await ref.update({
        status: "FAILED",
        failedAt: FieldValue.serverTimestamp()
      });
    }

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

  /*
   * LOGIN REQUIRED — nobody can probe other people's orders.
   */
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
     * SYNC MODE: settle every pending order this user has.
     * The site calls this on login, tab focus and on a timer, so a payment
     * completed while the browser was closed still unlocks.
     */
    if (sync) {

      const snap = await adminDb.collection("orders")
        .where("uid", "==", uid)
        .where("status", "==", "PENDING")
        .limit(10)
        .get();

      await Promise.allSettled(snap.docs.map((d) => settleOrder(d.id)));

      return res.json({
        success: true,
        checked: snap.size
      });

    }

    /*
     * SINGLE ORDER MODE (used by the payment modal)
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

    console.error("Order status error:", error);

    return res.status(502).json({
      success: false,
      message: "Could not check payment yet. Retrying."
    });

  }

}
