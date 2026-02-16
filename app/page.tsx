import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { EnrollmentButton } from '@/components/EnrollmentButton';
import { Course, Enrollment } from '@/types';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createServerComponentClient({ cookies });
  
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  
  // Fetch published courses
  const { data: courses } = await supabase
    .from('courses')
    .select('*')
    .eq('status', 'published')
    .order('created_at', { ascending: false });
  
  // Fetch user's enrollments if logged in
  let enrollments: Enrollment[] = [];
  if (user) {
    const { data: userEnrollments } = await supabase
      .from('enrollments')
      .select('*')
      .eq('user_id', user.id);
    enrollments = userEnrollments || [];
  }
  
  const enrollmentMap = new Map(enrollments.map(e => [e.course_id, e]));
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">
            Genesis Digital Assets Training
          </h1>
          <div>
            {user ? (
              <div className="flex items-center gap-4">
                <span className="text-gray-600">{user.email}</span>
                <form action="/api/auth/signout" method="POST">
                  <button 
                    type="submit"
                    className="text-red-600 hover:text-red-800"
                  >
                    Sign Out
                  </button>
                </form>
              </div>
            ) : (
              <Link 
                href="/auth"
                className="text-blue-600 hover:text-blue-800 font-medium"
              >
                Sign In
              </Link>
            )}
          </div>
        </div>
      </header>
      
      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero */}
        <div className="text-center mb-12">
          <h2 className="text-4xl font-bold text-gray-900 mb-4">
            Master Digital Assets
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Comprehensive courses on cryptocurrency, blockchain, and digital asset management.
          </p>
          {user && (
            <Link
              href="/admin/import"
              className="inline-block mt-6 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
            >
              + Create New Course
            </Link>
          )}
        </div>
        
        {/* Course Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {courses?.map((course: Course) => {
            const enrollment = enrollmentMap.get(course.id);
            return (
              <div 
                key={course.id}
                className="bg-white rounded-lg shadow overflow-hidden hover:shadow-lg transition"
              >
                <div className="p-6">
                  <h3 className="text-xl font-bold text-gray-900 mb-2">
                    {course.title}
                  </h3>
                  <p className="text-gray-600 mb-4 line-clamp-2">
                    {course.description || 'No description available'}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-2xl font-bold text-gray-900">
                      {course.price_usd === 0 ? 'Free' : `$${course.price_usd}`}
                    </span>
                    <EnrollmentButton
                      courseId={course.id}
                      price={course.price_usd}
                      isEnrolled={!!enrollment}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {(!courses || courses.length === 0) && (
          <div className="text-center py-12">
            <p className="text-gray-500 text-lg">
              No courses available yet. Check back soon!
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
