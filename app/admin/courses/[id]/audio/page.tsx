import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { AudioUploader } from '@/components/AudioUploader';
import Link from 'next/link';

interface AudioPageProps {
  params: { id: string };
}

export default async function AudioPage({ params }: AudioPageProps) {
  const supabase = createServerComponentClient({ cookies });
  
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    redirect('/auth');
  }
  
  // Fetch course
  const { data: course } = await supabase
    .from('courses')
    .select('*')
    .eq('id', params.id)
    .single();
  
  if (!course) {
    notFound();
  }
  
  // Verify ownership
  if (course.created_by !== user.id) {
    redirect('/');
  }
  
  // Fetch slides
  const { data: slides } = await supabase
    .from('slides')
    .select('*')
    .eq('course_id', params.id)
    .order('slide_number', { ascending: true });
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-4">
          <Link href="/admin/import" className="text-gray-600 hover:text-gray-900">
            ← Back to Admin
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            Audio Upload: {course.title}
          </h1>
        </div>
      </header>
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AudioUploader courseId={params.id} slides={slides || []} />
      </main>
    </div>
  );
}
