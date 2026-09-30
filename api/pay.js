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

const PALMPESA_TIMEOUT_MS = 25000;

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

  if (MPESA_PREFIXES.has(prefix)) {
    return "MPESA";
  }

  if (AIRTEL_PREFIXES.has(prefix)) {
    return "AIRTEL";
  }

  if (HALOTEL_PREFIXES.has(prefix)) {
    return "HALOPESA";
  }

  if (MIXX_PREFIXES.has(prefix)) {
    return "MIXX";
  }

  if (TTCL_PREFIXES.has(prefix)) {
    return "TTCL";
  }

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

    const postSnap = await adminDb.doc(`posts/${postId}`).get();

    if (!postSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Betslip not found or expired."
      });
    }

    const postData = postSnap.data();

    const amount = Number(postData.price);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid betslip price."
      });
    }

    const secretSnap = await adminDb.doc(`postSecrets/${postId}`).get();

    const betslipContent = secretSnap.exists
      ? (secretSnap.data().content || "")
      : (postData.content || "");

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

    let response;

    try {

      response = await fetchWithTimeout(
        "https://palmpesa.drmlelwa.co.tz/api/pay-via-mobile",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.PALMPESA_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(paymentData)
        },
        PALMPESA_TIMEOUT_MS
      );

    } catch (fetchError) {

      const timedOut = fetchError.name === "AbortError";

      console.error(
        "PalmPesa request failed:",
        timedOut ? "timed out" : fetchError.message
      );

      return res.status(504).json({
        success: false,
        message: timedOut
          ? "PalmPesa is slow to respond. If a PIN prompt appears on your phone, complete it before trying again to avoid paying twice."
          : "Unable to reach PalmPesa. Please try again.",
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
      raw: rawResponse
    });

    if (orderId) {

      await adminDb.doc(`orders/${orderId}`).set({
        uid,
        postId,
        amount,
        phone: normalizedPhone,
        transactionId,
        title: postData.title || "",
        platform: postData.platform || "",
        content: betslipContent,
        status: "PENDING",
        createdAt: FieldValue.serverTimestamp()
      });

    } else {

      console.error(
        "NO ORDER ID from PalmPesa. Raw:",
        rawResponse,
        "uid:",
        uid,
        "postId:",
        postId
      );

    }

    return res.status(response.status).json({
      success: response.ok,
      palmPesaStatus: response.status,
      transaction_id: transactionId,
      order_id: orderId,
      detected_network: network,
      normalized_phone: normalizedPhone,
      data: data
    });

  } catch (error) {

    console.error("PalmPesa payment server error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while contacting PalmPesa",
      error: error.message
    });

  }

}
