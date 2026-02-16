import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const { title, description, price } = await req.json();
  
  const supabase = createRouteHandlerClient({ cookies });
  
  // Get authenticated user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Create course (without Gamma scraping for now)
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .insert({
        title: title || 'Untitled Course',
        description: description || null,
        price_usd: price || 0,
        status: 'draft',
        created_by: user.id,
      })
      .select()
      .single();
      
    if (courseError) {
      throw courseError;
    }
    
    return NextResponse.json({ 
      success: true, 
      courseId: course.id,
      message: 'Course created successfully. You can now upload slides and audio manually.'
    });
    
  } catch (error: any) {
    console.error('Import error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create course' }, 
      { status: 500 }
    );
  }
}
