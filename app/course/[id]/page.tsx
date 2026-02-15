import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { CoursePlayer } from '@/components/CoursePlayer';
import { EnrollmentButton } from '@/components/EnrollmentButton';

interface CoursePageProps {
  params: { id: string };
  searchParams: { success?: string; canceled?: string };
}

export default async function CoursePage({ params, searchParams }: CoursePageProps) {
  const supabase = createServerComponentClient({ cookies });
  
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  
  // Fetch course with slides
  const { data: course } = await supabase
    .from('courses')
    .select('*')
    .eq('id', params.id)
    .single();
  
  if (!course) {
    notFound();
  }
  
  // Fetch slides
  const { data: slides } = await supabase
    .from('slides')
    .select('*')
    .eq('course_id', params.id)
    .order('slide_number', { ascending: true });
  
  // Check enrollment if user is logged in
  let enrollment = null;
  let progress = null;
  
  if (user) {
    const { data: userEnrollment } = await supabase
      .from('enrollments')
      .select('*')
      .eq('user_id', user.id)
      .eq('course_id', params.id)
      .single();
    
    enrollment = userEnrollment;
    
    if (enrollment) {
      const { data: userProgress } = await supabase
        .from('progress')
        .select('*')
        .eq('user_id', user.id)
        .eq('course_id', params.id);
      
      progress = userProgress;
    }
  }
  
  // Show enrollment prompt if not enrolled and not preview mode
  const isPreview = searchParams.success !== 'true' && !enrollment;
  
  if (isPreview) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 py-12">
          <div className="bg-white rounded-lg shadow p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-4">{course.title}</h1>
            <p className="text-gray-600 mb-6">{course.description}</p>
            
            <div className="flex items-center justify-between mb-8">
              <span className="text-3xl font-bold text-gray-900">
                {course.price_usd === 0 ? 'Free' : `$${course.price_usd}`}
              </span>
              <EnrollmentButton
                courseId={course.id}
                price={course.price_usd}
                isEnrolled={false}
              />
            </div>
            
            {searchParams.canceled === 'true' && (
              <div className="p-4 bg-yellow-50 text-yellow-700 rounded-lg mb-6">
                Payment was canceled. You can try again when you're ready.
              </div>
            )}
            
            <div className="border-t pt-6">
              <h2 className="text-xl font-semibold mb-4">Course Preview</h2>
              <p className="text-gray-600">
                This course contains {slides?.length || 0} slides with audio narration.
              </p>
              <p className="text-gray-600 mt-2">
                Enroll now to get full access to all course materials.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  // Show course player if enrolled
  if (!enrollment && !user) {
    redirect('/auth');
  }
  
  if (!enrollment) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Enroll to Access</h2>
          <p className="text-gray-600 mb-6">You need to enroll in this course to view the content.</p>
          <EnrollmentButton
            courseId={course.id}
            price={course.price_usd}
            isEnrolled={false}
          />
        </div>
      </div>
    );
  }
  
  return (
    <CoursePlayer
      courseId={params.id}
      slides={slides || []}
      initialProgress={progress || []}
    />
  );
}
