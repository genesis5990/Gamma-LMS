'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface EnrollmentButtonProps {
  courseId: string;
  price: number;
  isEnrolled?: boolean;
}

export function EnrollmentButton({ courseId, price, isEnrolled }: EnrollmentButtonProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  
  const handleEnroll = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId }),
      });
      
      const data = await response.json();
      
      if (response.ok && data.url) {
        // Redirect to Stripe Checkout
        window.location.href = data.url;
      } else if (response.status === 401) {
        // Not logged in, redirect to auth
        router.push('/auth');
      } else {
        alert(data.error || 'Failed to start enrollment');
      }
    } catch (error) {
      console.error('Enrollment error:', error);
      alert('Failed to start enrollment');
    } finally {
      setLoading(false);
    }
  };
  
  if (isEnrolled) {
    return (
      <button
        onClick={() => router.push(`/course/${courseId}`)}
        className="w-full py-3 px-6 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition"
      >
        Continue Learning
      </button>
    );
  }
  
  return (
    <button
      onClick={handleEnroll}
      disabled={loading}
      className="w-full py-3 px-6 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      {loading ? 'Processing...' : price === 0 ? 'Enroll for Free' : `Enroll - $${price}`}
    </button>
  );
}
