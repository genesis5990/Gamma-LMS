import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

export async function POST(req: Request) {
  try {
    const { courseId } = await req.json();
    const supabase = createRouteHandlerClient({ cookies });

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get course details
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .single();

    if (courseError || !course) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 });
    }

    // Check if already enrolled
    const { data: existingEnrollment } = await supabase
      .from('enrollments')
      .select('*')
      .eq('user_id', user.id)
      .eq('course_id', courseId)
      .single();

    if (existingEnrollment) {
      return NextResponse.json({ error: 'Already enrolled' }, { status: 400 });
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer_email: user.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { 
            name: course.title,
            description: course.description || undefined 
          },
          unit_amount: Math.round(course.price_usd * 100), // cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/course/${courseId}?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/course/${courseId}?canceled=true`,
      metadata: { 
        user_id: user.id, 
        course_id: courseId 
      },
    });

    // Store pending enrollment
    await supabase.from('pending_enrollments').insert({
      user_id: user.id,
      course_id: courseId,
      stripe_payment_link: session.url,
      status: 'pending_payment'
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error('Enrollment error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}
