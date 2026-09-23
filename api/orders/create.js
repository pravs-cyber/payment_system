import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { paypalRequest } from '../../lib/paypal.js';
import { calculateOrder } from '../../lib/catalog.js';

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
    if (!recipientName || !birthdayMessage || !theme) {
      return res.status(400).json({ error: 'Theme, recipient name and birthday message are required' });
    }
    if (packageName === 'Custom') {
      return res.status(400).json({ error: 'Custom orders are handled through Instagram' });
    }

    const pricing = calculateOrder({ packageName, deployment, addons });
    const localOrderId = randomUUID();

    const { error: insertError } = await supabaseAdmin.from('orders').insert({
      id: localOrderId,
      customer_email: customerEmail.trim(),
      recipient_name: recipientName.trim(),
      birthday_message: birthdayMessage.trim(),
      notes: notes?.trim() || null,
      theme_id: theme,
      package_id: packageName,
      deployment_plan: deployment || null,
      addons: pricing.addons,
      total_usd: pricing.total,
      status: 'payment_pending',
      payment_status: 'unpaid',
      payment_provider: 'paypal'
    });

    if (insertError) throw insertError;

    const paypalOrder = await paypalRequest('/v2/checkout/orders', {
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

    await supabaseAdmin.from('orders').update({
      payment_provider_order_id: paypalOrder.id
    }).eq('id', localOrderId);

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
