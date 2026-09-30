import { adminDb, adminAuth, FieldValue } from "../lib/admin.js";

const MPESA_PREFIXES = new Set([
  "740", "741", "742", "743", "744", "745", "746", "747", "748", "749",
  "750", "751", "752", "753", "754", "755", "756", "757", "758", "759",
  "760", "761", "762", "763", "764", "765", "766", "767", "768", "769",
  "770", "771", "772", "773", "774", "775", "776", "777", "778", "779"
]);

const AIRTEL_PREFIXES = new Set([
  "680", "681", "682", "683", "684", "685", "686", "687", "688", "689",
  "690", "691", "692", "693", "694", "695", "696", "697", "698", "699"
]);

const HALOTEL_PREFIXES = new Set([
  "620", "621", "622", "623", "624", "625", "626", "627", "628", "629"
]);

const MIXX_PREFIXES = new Set([
  "650", "651", "652", "653", "654", "655", "656", "657", "658", "659",
  "660", "661", "662", "663", "664", "665", "666", "667", "668", "669",
  "670", "671", "672", "673", "674", "675", "676", "677", "678", "679"
]);

const TTCL_PREFIXES = new Set([
  "710", "711", "712", "713", "714", "715", "716", "717", "718", "719"
]);

/*
 * Vercel Hobby cuts functions at about 10s, so stay under that.
 * If you are on a paid plan you can raise this.
 */
const PALMPESA_TIMEOUT_MS = 9000;

function normalizeTanzaniaPhone(value) {

  let p = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "");

  if (p.startsWith("+255")) {
    p = p.substring(1);
  }

  if (p.startsWith("0")) {
    p = "255" + p.substring(1);
  }

  return p;
}

function detectNetwork(prefix) {

  if (MPESA_PREFIXES.has(prefix)) return "MPESA";
  if (AIRTEL_PREFIXES.has(prefix)) return "AIRTEL";
  if (HALOTEL_PREFIXES.has(prefix)) return "HALOPESA";
  if (MIXX_PREFIXES.has(prefix)) return "MIXX";
  if (TTCL_PREFIXES.has(prefix)) return "TTCL";

  return "UNKNOWN";
}

async function fetchWithTimeout(url, options, timeoutMs) {

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {

    return await fetch(url, {
      ...options,
      signal: controller.signal
    });

  } finally {

    clearTimeout(timer);

  }

}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    /*
     * WHO IS PAYING? Verify the Firebase login token.
     */
    const idToken =
      (req.headers.authorization || "").replace("Bearer ", "");

    let uid;

    try {
      uid = (await adminAuth.verifyIdToken(idToken)).uid;
    } catch {
      return res.status(401).json({
        success: false,
        message: "Please sign in again."
      });
    }

    const { name, email, phone, postId } = req.body || {};

    if (!name || !email || !phone || !postId) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    /*
     * PRICE + CONTENT COME FROM THE DATABASE, NEVER FROM THE BROWSER
     */
    const postSnap = await adminDb.doc(`posts/${postId}`).get();

    if (!postSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Betslip not found or expired."
      });
    }

    const post = postSnap.data();

    const expiresMs = post.expiresAt?.toMillis?.();

    if (expiresMs && expiresMs <= Date.now()) {
      return res.status(410).json({
        success: false,
        message: "This betslip has expired."
      });
    }

    const amount = Number(post.price);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid betslip price."
      });
    }

    /*
     * Snapshot the VIP content now, so a later delete/expiry
     * can't leave a paid buyer with nothing.
     */
    const secretSnap = await adminDb.doc(`postSecrets/${postId}`).get();

    const vipContent = secretSnap.exists
      ? (secretSnap.data().content || "")
      : (post.content || "");

    const normalizedPhone = normalizeTanzaniaPhone(phone);

    if (!/^255\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid Tanzania phone number. Use 07XXXXXXXX, 06XXXXXXXX or +255XXXXXXXXX."
      });
    }

    const prefix = normalizedPhone.substring(3, 6);

    const network = detectNetwork(prefix);

    const transactionId =
      "TXN-" +
      Date.now() +
      "-" +
      Math.floor(Math.random() * 10000);

    const paymentData = {
      name: name,
      email: email,
      phone: normalizedPhone,
      amount: amount,
      transaction_id: transactionId,
      address: "Geita",
      postcode: "30100",
      network: network
    };

    console.log("PalmPesa payment request:", {
      uid,
      postId,
      normalizedPhone,
      prefix,
      network,
      amount,
      transactionId
    });

    /*
     * SEND TO PALMPESA
     */
    let response;

    try {

      response = await fetchWithTimeout(
        "https://palmpesa.drmlelwa.co.tz/api/pay-via-mobile",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.PALMPESA_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; MikekaBoom/1.0)"
          },
          body: JSON.stringify(paymentData)
        },
        PALMPESA_TIMEOUT_MS
      );

    } catch (fetchError) {

      const timedOut = fetchError.name === "AbortError";

      console.error(
        "PalmPesa request failed:",
        timedOut ? "timed out" : fetchError.message,
        "transactionId:",
        transactionId,
        "uid:",
        uid,
        "postId:",
        postId
      );

      return res.status(504).json({
        success: false,
        message: timedOut
          ? "The payment service is slow to respond. If a PIN prompt appears on your phone, complete it and wait. Otherwise try again in a few minutes."
          : "Unable to reach the payment service. Please try again.",
        transaction_id: transactionId
      });

    }

    const rawResponse = await response.text();

    let data;

    try {
      data = JSON.parse(rawResponse);
    } catch {
      data = { raw_response: rawResponse };
    }

    const orderId =
      data?.order_id ||
      data?.data?.order_id ||
      data?.data?.data?.order_id ||
      data?.order?.order_id ||
      null;

    console.log("PalmPesa response:", {
      httpStatus: response.status,
      orderId,
      raw: String(rawResponse).slice(0, 500)
    });

    /*
     * PROVIDER ERRORS -> CLEAR MESSAGE FOR THE USER
     */
    const looksLikeHtml =
      typeof data?.raw_response === "string" &&
      data.raw_response.trim().startsWith("<");

    if (looksLikeHtml) {

      console.error(
        "PalmPesa returned an HTML page (firewall/captcha/down).",
        "HTTP:", response.status,
        "transactionId:", transactionId,
        "uid:", uid,
        "postId:", postId
      );

      return res.status(503).json({
        success: false,
        message: "The payment service is temporarily unavailable. You have not been charged. Please try again in a few minutes.",
        transaction_id: transactionId
      });

    }

    const providerMessage =
      data?.message ||
      data?.data?.message ||
      data?.error ||
      "";

    if (!response.ok) {

      return res.status(502).json({
        success: false,
        message: providerMessage || ("The payment provider rejected the request (HTTP " + response.status + ")."),
        palmPesaStatus: response.status,
        transaction_id: transactionId
      });

    }

    if (!orderId) {

      console.error(
        "NO ORDER ID from PalmPesa. Raw:",
        String(rawResponse).slice(0, 500),
        "uid:", uid,
        "postId:", postId,
        "transactionId:", transactionId
      );

      return res.status(502).json({
        success: false,
        message: providerMessage || "The payment provider did not return an order ID. Please try again.",
        transaction_id: transactionId
      });

    }

    /*
     * SAVE THE ORDER (with the content snapshot) so any later
     * status check can unlock the right user's betslip.
     */
    await adminDb.doc(`orders/${orderId}`).set({
      uid,
      postId,
      amount,
      title: post.title || "",
      platform: post.platform || "",
      content: vipContent,
      phone: normalizedPhone,
      transactionId,
      status: "PENDING",
      createdAt: FieldValue.serverTimestamp()
    });

    return res.json({
      success: true,
      transaction_id: transactionId,
      order_id: orderId,
      detected_network: network
    });

  } catch (error) {

    console.error("PalmPesa payment server error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while contacting the payment service. Please try again.",
      error: error.message
    });

  }

}
