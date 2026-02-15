import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { path } = await req.json();
    
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    if (!path) {
      return NextResponse.json(
        { error: 'Path required' }, 
        { status: 400 }
      );
    }
    
    // Get course ID from path (course_COURSEID/slide_NUMBER.mp3)
    const courseIdMatch = path.match(/course_([^/]+)/);
    if (!courseIdMatch) {
      return NextResponse.json(
        { error: 'Invalid path format' }, 
        { status: 400 }
      );
    }
    
    const courseId = courseIdMatch[1];
    
    // Check enrollment
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
    
    // Create signed URL (valid for 1 hour)
    const { data, error } = await supabase
      .storage
      .from('course-audio')
      .createSignedUrl(path, 3600);
      
    if (error) {
      console.error('Error creating signed URL:', error);
      return NextResponse.json(
        { error: 'Failed to generate audio URL' }, 
        { status: 500 }
      );
    }
    
    return NextResponse.json({ url: data.signedUrl });
    
  } catch (error: any) {
    console.error('Audio URL error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}
