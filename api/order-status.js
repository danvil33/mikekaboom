import { adminAuth } from "../lib/admin.js";
import { settleOrder } from "../lib/orders.js";
import { SplashPayConfigError } from "../lib/splashpay.js";

/*
 * Customer-facing status check. Requires a Firebase login; only the order's
 * owner can check it. Final truth always comes from SplashPay's Status API
 * (via settleOrder) — nothing here trusts the browser.
 */
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {

    const idToken = (req.headers.authorization || "").replace("Bearer ", "");
    let uid;
    try {
      uid = (await adminAuth.verifyIdToken(idToken)).uid;
    } catch {
      return res.status(401).json({ success: false, message: "Please sign in again." });
    }

    const { order_id } = req.body || {};
    if (!order_id || typeof order_id !== "string" || order_id.includes("/")) {
      return res.status(400).json({ success: false, message: "order_id is required" });
    }

    let result;
    try {
      result = await settleOrder(order_id);
    } catch (err) {
      if (err instanceof SplashPayConfigError) {
        return res.status(503).json({ success: false, message: "Payments are temporarily unavailable." });
      }
      console.error("Order status error:", order_id, err.message);
      // Transient: tell the client to keep waiting rather than fail the order
      return res.status(200).json({
        success: true,
        order_id,
        payment_status: "PENDING",
        detail_status: "pending",
        message: "Still checking payment..."
      });
    }

    if (!result.found || result.order.uid !== uid) {
      // same response for "missing" and "someone else's" — no order enumeration
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    return res.json({
      success: true,
      order_id,
      payment_status: result.payment_status,
      detail_status: result.detail_status
    });

  } catch (error) {
    console.error("Order status server error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while checking payment status."
    });
  }
}
