import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// GET: Fetch user's progress for a course
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const courseId = searchParams.get('courseId');
    
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    if (!courseId) {
      return NextResponse.json(
        { error: 'Course ID required' }, 
        { status: 400 }
      );
    }
    
    // Get progress for this course
    const { data: progress, error } = await supabase
      .from('progress')
      .select('*')
      .eq('user_id', user.id)
      .eq('course_id', courseId);
      
    if (error) {
      console.error('Error fetching progress:', error);
      return NextResponse.json(
        { error: 'Failed to fetch progress' }, 
        { status: 500 }
      );
    }
    
    return NextResponse.json({ progress });
    
  } catch (error: any) {
    console.error('Progress GET error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}

// POST: Save progress
export async function POST(req: Request) {
  try {
    const { courseId, slideId, slideNumber, audioPosition, completed } = await req.json();
    
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Verify enrollment
    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('*')
      .eq('user_id', user.id)
      .eq('course_id', courseId)
      .single();
      
    if (!enrollment) {
      return NextResponse.json(
        { error: 'Not enrolled in this course' }, 
        { status: 403 }
      );
    }
    
    // Upsert progress
    const { error } = await supabase
      .from('progress')
      .upsert({
        user_id: user.id,
        course_id: courseId,
        slide_id: slideId,
        slide_number: slideNumber,
        audio_position: audioPosition || 0,
        completed: completed || false,
        completed_at: completed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,course_id,slide_id'
      });
      
    if (error) {
      console.error('Error saving progress:', error);
      return NextResponse.json(
        { error: 'Failed to save progress' }, 
        { status: 500 }
      );
    }
    
    return NextResponse.json({ success: true });
    
  } catch (error: any) {
    console.error('Progress POST error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}
