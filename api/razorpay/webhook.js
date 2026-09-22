import crypto from "node:crypto";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!signature) return res.status(400).json({ error: "Missing signature" });

    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      const orderId = payment?.notes?.bdaystudio_order_id;

      if (orderId) {
        await supabaseAdmin.from("orders").update({
          payment_status: "paid",
          status: "paid",
          paid_at: new Date().toISOString()
        }).eq("id", orderId);
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
