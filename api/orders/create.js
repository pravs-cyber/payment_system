import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { paypalRequest } from '../../lib/paypal.js';
import { calculateOrder } from '../../lib/catalog.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const {
      customerEmail,
      recipientName,
      birthdayMessage,
      notes,
      theme,
      packageName,
      deployment,
      addons = []
    } = body;

    if (!customerEmail || !/^\S+@\S+\.\S{2,}$/.test(customerEmail.trim())) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!recipientName?.trim() || !birthdayMessage?.trim() || !theme?.trim()) {
      return res.status(400).json({ error: 'Theme, recipient name and birthday message are required' });
    }
    if (!packageName || packageName === 'Custom') {
      return res.status(400).json({ error: 'Custom orders are handled through Instagram' });
    }

    const pricing = calculateOrder({ packageName, deployment, addons });
    if (!Number.isFinite(pricing.total) || pricing.total <= 0) {
      return res.status(400).json({ error: 'Could not calculate a valid order total' });
    }

    const localOrderId = randomUUID();

    const { error: insertError } = await ordersTable().insert({
      id: localOrderId,
      customer_email: customerEmail.trim(),
      recipient_name: recipientName.trim(),
      birthday_message: birthdayMessage.trim(),
      notes: notes?.trim() || null,
      theme_id: theme.trim(),
      package_id: packageName,
      deployment_plan: deployment || null,
      addons: pricing.addons,
      total_usd: pricing.total,
      status: 'payment_pending',
      payment_status: 'unpaid',
      payment_provider: 'paypal'
    });

    if (insertError) {
      console.error('Supabase orders insert failed:', insertError);
      const message = insertError.message || 'Could not save the order';
      if (/schema cache|public\.orders|relation .*orders/i.test(message)) {
        return res.status(503).json({
          error: 'Supabase cannot see public.orders. Make sure the public schema is exposed in Supabase Data API and that SUPABASE_SECRET_KEY belongs to this same project.'
        });
      }
      throw insertError;
    }

    let paypalOrder;
    try {
      paypalOrder = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `bdaystudio-${localOrderId}` },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: localOrderId,
            custom_id: localOrderId,
            description: `bdaystudio ${packageName} website`,
            amount: {
              currency_code: 'USD',
              value: pricing.total.toFixed(2)
            }
          }]
        })
      });
    } catch (paypalError) {
      await ordersTable().update({ status: 'payment_error' }).eq('id', localOrderId);
      throw paypalError;
    }

    const { error: updateError } = await ordersTable()
      .update({ payment_provider_order_id: paypalOrder.id })
      .eq('id', localOrderId);

    if (updateError) throw updateError;

    return res.status(201).json({
      id: paypalOrder.id,
      localOrderId,
      total: pricing.total
    });
  } catch (error) {
    console.error('Order creation failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not create checkout order' });
  }
}
