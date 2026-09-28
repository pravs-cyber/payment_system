import { paypalRequest } from "../../lib/paypal.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId, paypalOrderId } = req.body || {};
    if (!orderId || !paypalOrderId) {
      return res.status(400).json({ error: "orderId and paypalOrderId are required" });
    }

    const capture = await paypalRequest(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: { "PayPal-Request-Id": `capture-${orderId}-${paypalOrderId}` }
    });

    const completed = capture.status === "COMPLETED";

    if (completed) {
      await supabaseAdmin.from("orders").update({
        payment_status: "paid",
        status: "paid",
        paid_at: new Date().toISOString()
      }).eq("id", orderId).eq("payment_provider_order_id", paypalOrderId);
    }

    return res.status(200).json({
      ok: completed,
      status: capture.status,
      capture
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not capture PayPal payment" });
  }
}
