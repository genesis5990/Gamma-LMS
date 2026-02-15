import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get authenticated user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('audio') as File;
    const courseId = formData.get('courseId') as string;
    const slideNumber = parseInt(formData.get('slideNumber') as string);
    
    if (!file || !courseId || !slideNumber) {
      return NextResponse.json(
        { error: 'Missing required fields' }, 
        { status: 400 }
      );
    }
    
    // Verify user owns the course
    const { data: course } = await supabase
      .from('courses')
      .select('created_by')
      .eq('id', courseId)
      .single();
      
    if (!course || course.created_by !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized to modify this course' }, 
        { status: 403 }
      );
    }
    
    // Validate file type
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Invalid file type. Allowed: MP3, WAV, WebM' }, 
        { status: 400 }
      );
    }
    
    // Validate file size (50MB max)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'File too large. Max size: 50MB' }, 
        { status: 400 }
      );
    }
    
    // Convert file to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    // Generate file path
    const fileName = `course_${courseId}/slide_${slideNumber}.mp3`;
    
    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('course-audio')
      .upload(fileName, buffer, {
        contentType: file.type,
        upsert: true,
      });
      
    if (uploadError) {
      console.error('Upload error:', uploadError);
      return NextResponse.json(
        { error: 'Failed to upload audio' }, 
        { status: 500 }
      );
    }
    
    // Get audio duration
    // Note: In a production app, you'd use a library like music-metadata
    // For now, we'll estimate or let the client provide it
    const duration = parseInt(formData.get('duration') as string) || 0;
    
    // Update slide record
    const { error: updateError } = await supabase
      .from('slides')
      .update({
        audio_path: fileName,
        duration_seconds: duration || null,
      })
      .eq('course_id', courseId)
      .eq('slide_number', slideNumber);
      
    if (updateError) {
      console.error('Database update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update slide' }, 
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      path: fileName,
      duration,
    });
    
  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}
