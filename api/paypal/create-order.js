import { paypalRequest } from "../../lib/paypal.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("id,total_usd,status,payment_status")
      .eq("id", orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: "Order not found" });
    if (order.status === "cancelled") return res.status(400).json({ error: "Order is cancelled" });
    if (!order.total_usd || Number(order.total_usd) <= 0) {
      return res.status(400).json({ error: "Invalid order total" });
    }

    const paypalOrder = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "PayPal-Request-Id": `bdaystudio-${order.id}`
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          amount: {
            currency_code: "USD",
            value: Number(order.total_usd).toFixed(2)
          }
        }]
      })
    });

    await supabaseAdmin.from("orders").update({
      payment_provider: "paypal",
      payment_status: "pending",
      payment_provider_order_id: paypalOrder.id
    }).eq("id", order.id);

    return res.status(200).json({ id: paypalOrder.id });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not create PayPal order" });
  }
}
