import Stripe from 'stripe';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return NextResponse.json(
      { error: `Webhook Error: ${err.message}` }, 
      { status: 400 }
    );
  }

  const supabase = createRouteHandlerClient({ cookies });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const { user_id, course_id } = session.metadata!;

    try {
      // Create enrollment
      const { error: enrollmentError } = await supabase.from('enrollments').insert({
        user_id,
        course_id,
        payment_type: 'stripe',
        amount_paid: (session.amount_total || 0) / 100,
        stripe_session_id: session.id,
        status: 'active',
      });

      if (enrollmentError) {
        console.error('Error creating enrollment:', enrollmentError);
        return NextResponse.json(
          { error: 'Failed to create enrollment' }, 
          { status: 500 }
        );
      }

      // Update pending enrollment status
      await supabase
        .from('pending_enrollments')
        .update({ status: 'completed' })
        .eq('user_id', user_id)
        .eq('course_id', course_id);

      console.log(`Enrollment created for user ${user_id} in course ${course_id}`);
    } catch (error) {
      console.error('Error processing webhook:', error);
      return NextResponse.json(
        { error: 'Internal server error' }, 
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ received: true });
}
