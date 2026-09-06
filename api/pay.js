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


    /*
     * TANZANIA NETWORK DETECTION
     *
     * IMPORTANT:
     *
     * This is mainly for logging/debugging.
     * We DO NOT rely on this field for PalmPesa
     * routing unless their API explicitly supports it.
     */
    let network = "UNKNOWN";


    /*
     * VODACOM / M-PESA
     */
    const mpesaPrefixes = [
      "740",
      "741",
      "742",
      "743",
      "744",
      "745",
      "746",
      "747",
      "748",
      "749",
      "750",
      "751",
      "752",
      "753",
      "754",
      "755",
      "756",
      "757",
      "758",
      "759",
      "760",
      "761",
      "762",
      "763",
      "764",
      "765",
      "766",
      "767",
      "768",
      "769",
      "770",
      "771",
      "772",
      "773",
      "774",
      "775",
      "776",
      "777",
      "778",
      "779"
    ];


    /*
     * AIRTEL
     */
    const airtelPrefixes = [
      "680",
      "681",
      "682",
      "683",
      "684",
      "685",
      "686",
      "687",
      "688",
      "689",
      "690",
      "691",
      "692",
      "693",
      "694",
      "695",
      "696",
      "697",
      "698",
      "699"
    ];


    /*
     * HALOTEL
     */
    const halotelPrefixes = [
      "620",
      "621",
      "622",
      "623",
      "624",
      "625",
      "626",
      "627",
      "628",
      "629"
    ];


    /*
     * TIGO / MIXX BY YAS
     *
     * Number ranges can change, therefore
     * this is only a best-effort detection.
     */
    const mixxPrefixes = [
      "650",
      "651",
      "652",
      "653",
      "654",
      "655",
      "656",
      "657",
      "658",
      "659",
      "660",
      "661",
      "662",
      "663",
      "664",
      "665",
      "666",
      "667",
      "668",
      "669",
      "670",
      "671",
      "672",
      "673",
      "674",
      "675",
      "676",
      "677",
      "678",
      "679"
    ];


    /*
     * TTCL
     */
    const ttclPrefixes = [
      "710",
      "711",
      "712",
      "713",
      "714",
      "715",
      "716",
      "717",
      "718",
      "719"
    ];


    /*
     * DETECT
     */
    if (mpesaPrefixes.includes(prefix)) {

      network = "MPESA";

    } else if (airtelPrefixes.includes(prefix)) {

      network = "AIRTEL";

    } else if (halotelPrefixes.includes(prefix)) {

      network = "HALOPESA";

    } else if (mixxPrefixes.includes(prefix)) {

      network = "MIXX";

    } else if (ttclPrefixes.includes(prefix)) {

      network = "TTCL";

    }


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

      /*
       * EXTRA NETWORK INFORMATION
       */
      network: network

    };


    /*
     * SERVER DEBUG LOG
     */
    console.log(
      "================ PALMPESA PAYMENT ================"
    );

    console.log(
      "Customer:",
      name
    );

    console.log(
      "Original phone:",
      phone
    );

    console.log(
      "Normalized phone:",
      normalizedPhone
    );

    console.log(
      "Prefix:",
      prefix
    );

    console.log(
      "Detected network:",
      network
    );

    console.log(
      "Amount:",
      Number(amount)
    );

    console.log(
      "Post ID:",
      postId || "not provided"
    );

    console.log(
      "User ID:",
      userId || "not provided"
    );

    console.log(
      "Transaction ID:",
      transactionId
    );

    console.log(
      "=================================================="
    );


    /*
     * SEND TO PALMPESA
     */
    const response =
      await fetch(
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

        }
      );


    /*
     * READ RAW RESPONSE
     */
    const rawResponse =
      await response.text();


    console.log(
      "PalmPesa HTTP status:",
      response.status
    );


    console.log(
      "PalmPesa raw response:",
      rawResponse
    );


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


    /*
     * FINAL DEBUG
     */
    console.log(
      "Detected PalmPesa order ID:",
      orderId
    );


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
