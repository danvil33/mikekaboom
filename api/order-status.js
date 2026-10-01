import { adminDb, FieldValue } from "../lib/admin.js";

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
 * Gives the buyer their purchase record, INCLUDING the betslip text.
 *
 * Paid betslips keep posts/{id}.content EMPTY — the real text is stored in
 * postSecrets/{id}. The old code copied post.content, so every purchase was
 * saved with an empty content field. We now read the secret first.
 *
 * It also repairs purchases that were already saved with empty content:
 * if the order is already COMPLETED but the purchase has no text, the text
 * is filled in.
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

    const purchaseRef = adminDb.doc(
      `people/${order.uid}/purchases/${order.postId}`
    );

    const [postSnap, secretSnap, purchaseSnap] = await Promise.all([
      tx.get(adminDb.doc(`posts/${order.postId}`)),
      tx.get(adminDb.doc(`postSecrets/${order.postId}`)),
      tx.get(purchaseRef)
    ]);

    const post = postSnap.exists ? postSnap.data() : {};
    const secretContent = secretSnap.exists
      ? (secretSnap.data().content || "")
      : "";

    const content = secretContent || post.content || "";

    if (order.status === "COMPLETED") {

      // Already granted — only repair a purchase that has no text yet.
      if (!purchaseSnap.exists) {

        tx.set(purchaseRef, {
          postId: order.postId,
          orderId,
          amount: order.amount,
          title: post.title || "",
          content,
          platform: post.platform || "",
          status: "COMPLETED",
          paidAt: FieldValue.serverTimestamp()
        });

      } else if (!purchaseSnap.data().content && content) {

        tx.update(purchaseRef, { content });

      }

      return;
    }

    tx.set(purchaseRef, {
      postId: order.postId,
      orderId,
      amount: order.amount,
      title: post.title || "",
      content,
      platform: post.platform || "",
      status: "COMPLETED",
      paidAt: FieldValue.serverTimestamp()
    });

    tx.update(orderRef, {
      status: "COMPLETED",
      completedAt: FieldValue.serverTimestamp()
    });
  });
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    const { order_id } = req.body || {};

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id is required"
      });
    }

    console.log("Checking PalmPesa order:", order_id);

    const response = await fetch(
      "https://palmpesa.drmlelwa.co.tz/api/order-status",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.PALMPESA_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ order_id })
      }
    );

    const rawResponse = await response.text();

    console.log("PalmPesa status HTTP:", response.status);
    console.log("PalmPesa status response:", rawResponse);

    let data;
    try {
      data = JSON.parse(rawResponse);
    } catch {
      data = { raw_response: rawResponse };
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

    const status = classify(rawStatus);

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
        order_id
      );
    }

    if (status === "COMPLETED") {
      try {
        await grantPurchase(order_id);
      } catch (grantError) {
        console.error("grantPurchase failed:", order_id, grantError);
        return res.status(500).json({
          success: false,
          message: "Payment confirmed but unlock failed. Retrying."
        });
      }
    }

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      order_id,
      payment_status: status,
      raw_status: rawStatus || null,
      reference: payment?.reference || data?.reference || null,
      transid: payment?.transid || null,
      amount: payment?.amount || null,
      channel: payment?.channel || null,
      message: data?.message || null,
      data
    });

  } catch (error) {

    console.error("Order status server error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while checking payment status.",
      error: error.message
    });

  }

}
