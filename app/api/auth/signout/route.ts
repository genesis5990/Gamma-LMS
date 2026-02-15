import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const supabase = createRouteHandlerClient({ cookies });
  
  // Sign out
  await supabase.auth.signOut();
  
  return NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_SITE_URL));
}
