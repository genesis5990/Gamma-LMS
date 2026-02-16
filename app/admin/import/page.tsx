import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { GammaImporter } from '@/components/GammaImporter';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AdminImportPage() {
  const supabase = createServerComponentClient({ cookies });
  
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    redirect('/auth');
  }
  
  // Fetch user's courses
  const { data: courses } = await supabase
    .from('courses')
    .select('*')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false });
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-600 hover:text-gray-900">
              ← Back to Home
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
          </div>
        </div>
      </header>
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Import Section */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Import New Course</h2>
            <GammaImporter />
          </div>
          
          {/* Existing Courses */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Your Courses</h2>
            <div className="space-y-4">
              {courses?.map((course) => (
                <div 
                  key={course.id}
                  className="bg-white rounded-lg shadow p-4 flex justify-between items-center"
                >
                  <div>
                    <h3 className="font-semibold">{course.title}</h3>
                    <p className="text-sm text-gray-500">
                      {course.status === 'published' ? (
                        <span className="text-green-600">Published</span>
                      ) : (
                        <span className="text-yellow-600">Draft</span>
                      )}
                      {' • '}
                      ${course.price_usd}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {course.status === 'draft' && (
                      <Link
                        href={`/admin/courses/${course.id}/audio`}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition"
                      >
                        Add Audio
                      </Link>
                    )}
                  </div>
                </div>
              ))}
              
              {(!courses || courses.length === 0) && (
                <p className="text-gray-500 text-center py-8">
                  No courses yet. Import your first course above!
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
