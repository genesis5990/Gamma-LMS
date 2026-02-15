-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Courses table
CREATE TABLE courses (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    price_usd DECIMAL(10, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    gamma_source_url TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Slides table
CREATE TABLE slides (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    slide_number INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    audio_path TEXT,
    duration_seconds INTEGER,
    transcript TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(course_id, slide_number)
);

-- Enrollments table
CREATE TABLE enrollments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    payment_type TEXT CHECK (payment_type IN ('stripe', 'crypto')),
    amount_paid DECIMAL(10, 2),
    stripe_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'refunded', 'cancelled')),
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, course_id)
);

-- Progress tracking table
CREATE TABLE progress (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    slide_id UUID REFERENCES slides(id) ON DELETE CASCADE,
    slide_number INTEGER NOT NULL,
    audio_position INTEGER DEFAULT 0, -- Position in seconds
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, course_id, slide_id)
);

-- Pending enrollments (for payment processing)
CREATE TABLE pending_enrollments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    stripe_payment_link TEXT,
    status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'completed', 'expired')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE slides ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_enrollments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for courses
CREATE POLICY "Anyone can view published courses"
    ON courses FOR SELECT
    USING (status = 'published');

CREATE POLICY "Authenticated users can view all courses"
    ON courses FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can create courses"
    ON courses FOR INSERT
    TO authenticated
    WITH CHECK (created_by = auth.uid());

CREATE POLICY "Course creators can update their courses"
    ON courses FOR UPDATE
    TO authenticated
    USING (created_by = auth.uid());

-- RLS Policies for slides
CREATE POLICY "Anyone can view slides of published courses"
    ON slides FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM courses 
        WHERE courses.id = slides.course_id 
        AND courses.status = 'published'
    ));

CREATE POLICY "Authenticated users can view all slides"
    ON slides FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Course creators can manage slides"
    ON slides FOR ALL
    TO authenticated
    USING (EXISTS (
        SELECT 1 FROM courses 
        WHERE courses.id = slides.course_id 
        AND courses.created_by = auth.uid()
    ));

-- RLS Policies for enrollments
CREATE POLICY "Users can view their own enrollments"
    ON enrollments FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "System can create enrollments"
    ON enrollments FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- RLS Policies for progress
CREATE POLICY "Users can view their own progress"
    ON progress FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Users can update their own progress"
    ON progress FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their progress"
    ON progress FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid());

-- RLS Policies for pending_enrollments
CREATE POLICY "Users can view their own pending enrollments"
    ON pending_enrollments FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- Functions
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers
CREATE TRIGGER update_courses_updated_at BEFORE UPDATE ON courses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_progress_updated_at BEFORE UPDATE ON progress
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pending_enrollments_updated_at BEFORE UPDATE ON pending_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Storage buckets setup (run these in Supabase dashboard SQL editor)
-- Note: Storage buckets are created via the UI or API, not SQL
-- Create these buckets manually in Supabase Dashboard > Storage:
-- 1. "slides" - Public bucket for slide images
-- 2. "course-audio" - Private bucket for audio files
-- 3. "certificates" - Private bucket for completion certificates

-- Storage policies (to be set in Supabase dashboard)
-- slides bucket: Public read access, authenticated write
-- course-audio bucket: Authenticated read (via signed URLs), authenticated write
