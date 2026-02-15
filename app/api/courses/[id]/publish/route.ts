import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const courseId = params.id;
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Verify course ownership
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .single();
      
    if (courseError || !course) {
      return NextResponse.json(
        { error: 'Course not found' }, 
        { status: 404 }
      );
    }
    
    if (course.created_by !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized to publish this course' }, 
        { status: 403 }
      );
    }
    
    // Check if course has slides
    const { data: slides, error: slidesError } = await supabase
      .from('slides')
      .select('id')
      .eq('course_id', courseId);
      
    if (slidesError) {
      return NextResponse.json(
        { error: 'Failed to check slides' }, 
        { status: 500 }
      );
    }
    
    if (!slides || slides.length === 0) {
      return NextResponse.json(
        { error: 'Cannot publish course without slides' }, 
        { status: 400 }
      );
    }
    
    // Update course status to published
    const { error: updateError } = await supabase
      .from('courses')
      .update({ status: 'published' })
      .eq('id', courseId);
      
    if (updateError) {
      console.error('Error publishing course:', updateError);
      return NextResponse.json(
        { error: 'Failed to publish course' }, 
        { status: 500 }
      );
    }
    
    return NextResponse.json({ 
      success: true, 
      message: 'Course published successfully' 
    });
    
  } catch (error: any) {
    console.error('Publish error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}
