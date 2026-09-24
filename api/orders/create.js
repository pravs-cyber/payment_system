import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { calculateOrder } from '../../lib/catalog.js';
import { razorpayRequest, razorpayKeyId } from '../../lib/razorpay.js';

const USD_TO_INR = Number(process.env.BDAYSTUDIO_USD_TO_INR || 90);
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
      addons = [],
      currency = 'INR'
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
    if (!['INR', 'USD'].includes(currency)) {
      return res.status(400).json({ error: 'Unsupported checkout currency' });
    }

    const pricing = calculateOrder({ packageName, deployment, addons });
    if (!Number.isFinite(pricing.total) || pricing.total <= 0) {
      return res.status(400).json({ error: 'Could not calculate a valid order total' });
    }

    // INR is displayed/charged using a fixed storefront rate so the amount shown
    // on the site always matches the amount sent to Razorpay.
    const amountMajor = currency === 'INR'
      ? Math.round(pricing.total * USD_TO_INR)
      : Number(pricing.total.toFixed(2));
    const amountSubunits = Math.round(amountMajor * 100);
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
      payment_provider: 'razorpay'
    });

    if (insertError) throw insertError;

    try {
      const razorpayOrder = await razorpayRequest('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: amountSubunits,
          currency,
          receipt: `bday-${localOrderId.slice(0, 18)}`,
          notes: {
            local_order_id: localOrderId,
            package: packageName,
            theme: theme.trim()
          }
        })
      });

      const { error: updateError } = await ordersTable()
        .update({ payment_provider_order_id: razorpayOrder.id })
        .eq('id', localOrderId);

      if (updateError) throw updateError;

      return res.status(201).json({
        keyId: razorpayKeyId(),
        id: razorpayOrder.id,
        localOrderId,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        displayAmount: amountMajor,
        displayUsd: pricing.total
      });
    } catch (paymentError) {
      await ordersTable().update({ status: 'payment_error' }).eq('id', localOrderId);
      throw paymentError;
    }
  } catch (error) {
    console.error('Razorpay order creation failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not create Razorpay checkout order' });
  }
}
