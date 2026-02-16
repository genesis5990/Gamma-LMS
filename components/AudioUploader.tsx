'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Slide } from '@/types';

interface AudioUploaderProps {
  courseId: string;
  slides: Slide[];
}

export function AudioUploader({ courseId, slides }: AudioUploaderProps) {
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadedSlides, setUploadedSlides] = useState<Set<number>>(new Set());
  const router = useRouter();
  
  const handleFileSelect = useCallback(async (slideNumber: number, file: File) => {
    setUploading(slideNumber);
    
    try {
      // Get audio duration
      const audio = new Audio(URL.createObjectURL(file));
      const duration = await new Promise<number>((resolve) => {
        audio.onloadedmetadata = () => {
          resolve(audio.duration);
        };
        // Timeout in case metadata doesn't load
        setTimeout(() => resolve(0), 1000);
      });
      
      // Create form data
      const formData = new FormData();
      formData.append('audio', file);
      formData.append('courseId', courseId);
      formData.append('slideNumber', slideNumber.toString());
      formData.append('duration', Math.round(duration).toString());
      
      // Upload
      const response = await fetch('/api/upload-audio', {
        method: 'POST',
        body: formData,
      });
      
      if (response.ok) {
        setUploadedSlides(prev => new Set(Array.from(prev).concat(slideNumber)));
      } else {
        const error = await response.json();
        alert(`Upload failed: ${error.error}`);
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed. Please try again.');
    } finally {
      setUploading(null);
    }
  }, [courseId]);
  
  const handlePublish = async () => {
    try {
      const response = await fetch(`/api/courses/${courseId}/publish`, {
        method: 'POST',
      });
      
      if (response.ok) {
        alert('Course published successfully!');
        router.push('/');
      } else {
        const error = await response.json();
        alert(`Publish failed: ${error.error}`);
      }
    } catch (error) {
      console.error('Publish error:', error);
      alert('Failed to publish course');
    }
  };
  
  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Upload Audio for Slides</h2>
        <button
          onClick={handlePublish}
          className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
        >
          Publish Course
        </button>
      </div>
      
      <div className="grid gap-4">
        {slides.map((slide) => (
          <div 
            key={slide.id}
            className="flex items-center gap-4 p-4 bg-white rounded-lg shadow"
          >
            {/* Slide Thumbnail */}
            <div className="w-24 h-16 bg-gray-200 rounded overflow-hidden flex-shrink-0">
              <img
                src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/slides/${slide.image_path}`}
                alt={`Slide ${slide.slide_number}`}
                className="w-full h-full object-cover"
              />
            </div>
            
            {/* Slide Info */}
            <div className="flex-1">
              <h3 className="font-semibold">Slide {slide.slide_number}</h3>
              {slide.duration_seconds && (
                <p className="text-sm text-green-600">
                  ✓ Audio uploaded ({Math.round(slide.duration_seconds)}s)
                </p>
              )}
              {uploadedSlides.has(slide.slide_number) && !slide.duration_seconds && (
                <p className="text-sm text-green-600">✓ Just uploaded</p>
              )}
            </div>
            
            {/* Upload Button */}
            <label className="cursor-pointer">
              <input
                type="file"
                accept="audio/mp3,audio/wav,audio/webm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleFileSelect(slide.slide_number, file);
                  }
                }}
                disabled={uploading === slide.slide_number}
                className="hidden"
              />
              <span className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                uploading === slide.slide_number
                  ? 'bg-gray-300 cursor-not-allowed'
                  : slide.duration_seconds || uploadedSlides.has(slide.slide_number)
                  ? 'bg-green-100 text-green-700 hover:bg-green-200'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}>
                {uploading === slide.slide_number 
                  ? 'Uploading...' 
                  : slide.duration_seconds || uploadedSlides.has(slide.slide_number)
                  ? 'Replace Audio'
                  : 'Upload MP3'
                }
              </span>
            </label>
          </div>
        ))}
      </div>
      
      {slides.length === 0 && (
        <p className="text-center text-gray-500 py-8">
          No slides found. Please import a Gamma presentation first.
        </p>
      )}
    </div>
  );
}
