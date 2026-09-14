/*
 * ===========================================================
 * STATIC DATA — hoisted to module scope.
 *
 * These used to be declared *inside* the handler, which meant
 * every single payment request re-allocated five arrays and a
 * closure from scratch before doing any real work. Defining
 * them once at module load time (cold start) instead of once
 * per request is free performance.
 * ===========================================================
 */

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
 * How long we'll wait on PalmPesa before giving up and returning
 * a clean error to the frontend, instead of hanging until the
 * hosting platform's own (often much longer, and much less
 * informative) function timeout kicks in.
 */
const PALMPESA_TIMEOUT_MS = 15000;

/*
 * NORMALIZE TANZANIAN PHONE NUMBER
 *
 * Accepted:
 *
 * 0712345678
 * 0612345678
 * +255712345678
 * 255712345678
 */
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

/*
 * DETECT NETWORK FROM PREFIX
 *
 * Mainly for logging/debugging — not relied on for PalmPesa
 * routing unless their API explicitly supports it.
 */
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

/*
 * FETCH WITH TIMEOUT
 *
 * Wraps fetch with an AbortController so a slow or hung
 * PalmPesa endpoint fails fast with a clear error instead of
 * holding the request open until the platform kills it.
 */
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

  /*
   * ONLY POST
   */
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    /*
     * FRONTEND DATA
     */
    const {
      name,
      email,
      phone,
      amount,
      postId,
      userId
    } = req.body || {};


    /*
     * BASIC VALIDATION
     */
    if (
      !name ||
      !email ||
      !phone ||
      !amount
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }


    const normalizedPhone =
      normalizeTanzaniaPhone(phone);


    /*
     * VALIDATE TANZANIA NUMBER
     *
     * Tanzania mobile numbers normally become:
     *
     * 255XXXXXXXXX
     */
    if (
      !/^255\d{9}$/.test(normalizedPhone)
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Invalid Tanzania phone number. Use 07XXXXXXXX, 06XXXXXXXX or +255XXXXXXXXX."
      });

    }


    /*
     * GET THE PREFIX
     *
     * Example:
     *
     * 255712345678
     *      ^^^
     */
    const prefix =
      normalizedPhone.substring(3, 6);

    const network =
      detectNetwork(prefix);


    /*
     * UNIQUE TRANSACTION ID
     */
    const transactionId =
      "TXN-" +
      Date.now() +
      "-" +
      Math.floor(
        Math.random() * 10000
      );


    /*
     * PAYMENT DATA
     *
     * IMPORTANT:
     *
     * The original PalmPesa fields are preserved.
     *
     * `network` is added for debugging / possible
     * provider routing.
     */
    const paymentData = {

      name: name,

      email: email,

      phone: normalizedPhone,

      amount: Number(amount),

      transaction_id: transactionId,

      address: "Geita",

      postcode: "30100",

      network: network

    };


    /*
     * SERVER DEBUG LOG
     *
     * Collapsed into a single structured log line instead of a
     * dozen separate console.log calls — each one is a
     * synchronous write, and on most serverless platforms that
     * adds up to real latency on every request.
     */
    console.log("PalmPesa payment request:", {
      name,
      phone,
      normalizedPhone,
      prefix,
      network,
      amount: Number(amount),
      postId: postId || "not provided",
      userId: userId || "not provided",
      transactionId
    });


    /*
     * SEND TO PALMPESA — bounded by PALMPESA_TIMEOUT_MS so a
     * hung provider doesn't hang this whole request.
     */
    let response;

    try {

      response =
        await fetchWithTimeout(
          "https://palmpesa.drmlelwa.co.tz/api/pay-via-mobile",
          {
            method: "POST",

            headers: {

              "Authorization":
                `Bearer ${process.env.PALMPESA_TOKEN}`,

              "Content-Type":
                "application/json",

              "Accept":
                "application/json"

            },

            body:
              JSON.stringify(
                paymentData
              )

          },
          PALMPESA_TIMEOUT_MS
        );

    } catch (fetchError) {

      const timedOut =
        fetchError.name === "AbortError";

      console.error(
        "PalmPesa request failed:",
        timedOut ? "timed out" : fetchError.message
      );

      return res.status(504).json({

        success: false,

        message:
          timedOut
            ? "PalmPesa did not respond in time. Please try again."
            : "Unable to reach PalmPesa. Please try again.",

        transaction_id: transactionId

      });

    }


    /*
     * READ RAW RESPONSE
     */
    const rawResponse =
      await response.text();


    /*
     * PARSE JSON
     */
    let data;

    try {

      data =
        JSON.parse(
          rawResponse
        );

    } catch {

      data = {
        raw_response:
          rawResponse
      };

    }


    /*
     * TRY TO FIND ORDER ID
     *
     * Different API response structures
     * are handled.
     */
    const orderId =
      data?.order_id ||
      data?.data?.order_id ||
      data?.data?.data?.order_id ||
      data?.order?.order_id ||
      null;


    console.log("PalmPesa response:", {
      httpStatus: response.status,
      orderId
    });


    /*
     * RETURN TO FRONTEND
     */
    return res.status(
      response.status
    ).json({

      success:
        response.ok,

      palmPesaStatus:
        response.status,

      transaction_id:
        transactionId,

      order_id:
        orderId,

      detected_network:
        network,

      normalized_phone:
        normalizedPhone,

      data:
        data

    });


  } catch (error) {

    /*
     * SERVER ERROR
     */
    console.error(
      "PalmPesa payment server error:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Server error while contacting PalmPesa",

      error:
        error.message

    });

  }

}
