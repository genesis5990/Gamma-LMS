export interface Course {
  id: string;
  title: string;
  description: string | null;
  price_usd: number;
  status: 'draft' | 'published';
  gamma_source_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Slide {
  id: string;
  course_id: string;
  slide_number: number;
  image_path: string;
  audio_path: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  created_at: string;
}

export interface Enrollment {
  id: string;
  user_id: string;
  course_id: string;
  payment_type: 'stripe' | 'crypto' | null;
  amount_paid: number | null;
  stripe_session_id: string | null;
  status: 'active' | 'refunded' | 'cancelled';
  enrolled_at: string;
}

export interface Progress {
  id: string;
  user_id: string;
  course_id: string;
  slide_id: string;
  slide_number: number;
  audio_position: number;
  completed: boolean;
  completed_at: string | null;
  updated_at: string;
}

export interface PendingEnrollment {
  id: string;
  user_id: string;
  course_id: string;
  stripe_payment_link: string | null;
  status: 'pending_payment' | 'completed' | 'expired';
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface SlideWithProgress extends Slide {
  progress?: Progress;
  completed?: boolean;
}

export interface CourseWithSlides extends Course {
  slides: Slide[];
  enrollment?: Enrollment;
}
