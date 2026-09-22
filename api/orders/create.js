import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      customerName,
      customerEmail,
      country,
      themeId,
      packageId,
      deploymentPlan,
      addons = [],
      totalUsd,
      totalInr
    } = req.body || {};

    if (!customerEmail || !themeId || !packageId || !totalUsd) {
      return res.status(400).json({ error: "Missing required order fields" });
    }

    const { data, error } = await supabaseAdmin
      .from("orders")
      .insert({
        customer_name: customerName || null,
        customer_email: customerEmail,
        country: country || null,
        theme_id: themeId,
        package_id: packageId,
        deployment_plan: deploymentPlan || null,
        addons,
        total_usd: Number(totalUsd),
        total_inr: totalInr ? Number(totalInr) : null,
        status: "awaiting_payment",
        payment_status: "unpaid"
      })
      .select("id,status,total_usd,total_inr")
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Could not create order" });
  }
}
