import crypto from "node:crypto";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("id,total_usd,total_inr,status")
      .eq("id", orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: "Order not found" });
    if (!order.total_inr || Number(order.total_inr) <= 0) {
      return res.status(400).json({ error: "Indian INR total is required" });
    }

    const auth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: Math.round(Number(order.total_inr) * 100),
        currency: "INR",
        receipt: order.id,
        notes: { bdaystudio_order_id: order.id }
      })
    });

    const razorOrder = await response.json();
    if (!response.ok) {
      throw new Error(JSON.stringify(razorOrder));
    }

    await supabaseAdmin.from("orders").update({
      payment_provider: "razorpay",
      payment_status: "pending",
      payment_provider_order_id: razorOrder.id
    }).eq("id", order.id);

    return res.status(200).json({
      key: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: razorOrder.id,
      amount: razorOrder.amount,
      currency: razorOrder.currency
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not create Razorpay order" });
  }
}
