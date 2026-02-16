'use client';

import { useState, useRef, useEffect } from 'react';
import { createPagesBrowserClient } from '@supabase/auth-helpers-nextjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { Slide, Progress } from '@/types';

interface CoursePlayerProps {
  courseId: string;
  slides: Slide[];
  initialProgress?: Progress[];
}

export function CoursePlayer({ courseId, slides, initialProgress = [] }: CoursePlayerProps) {
  const [currentSlide, setCurrentSlide] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  // Initialize Supabase only on client side
  useEffect(() => {
    setSupabase(createPagesBrowserClient());
  }, []);
  
  const currentSlideData = slides.find(s => s.slide_number === currentSlide);
  const progressMap = new Map(initialProgress.map(p => [p.slide_number, p]));
  
  // Load audio when slide changes
  useEffect(() => {
    if (currentSlideData?.audio_path && supabase) {
      loadAudio(currentSlideData.audio_path);
    } else {
      setAudioUrl(null);
      setProgress(0);
      setCurrentTime(0);
    }
  }, [currentSlide, currentSlideData, supabase]);
  
  const loadAudio = async (path: string) => {
    setLoading(true);
    try {
      const response = await fetch('/api/audio-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      
      const data = await response.json();
      if (data.url) {
        setAudioUrl(data.url);
        
        // Restore previous position
        const savedProgress = progressMap.get(currentSlide);
        if (savedProgress && audioRef.current) {
          audioRef.current.currentTime = savedProgress.audio_position;
          setCurrentTime(savedProgress.audio_position);
        }
      }
    } catch (error) {
      console.error('Error loading audio:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const playSlide = () => {
    if (audioRef.current) {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };
  
  const pauseSlide = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };
  
  const restartSlide = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      setProgress(0);
      playSlide();
    }
  };
  
  const rewind = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - seconds);
    }
  };
  
  const saveProgress = async (slideNum: number, position: number, completed: boolean = false) => {
    if (!supabase) return;
    const slide = slides.find(s => s.slide_number === slideNum);
    if (!slide) return;
    
    try {
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          slideId: slide.id,
          slideNumber: slideNum,
          audioPosition: Math.round(position),
          completed,
        }),
      });
    } catch (error) {
      console.error('Error saving progress:', error);
    }
  };
  
  const nextSlide = () => {
    if (currentSlide < slides.length) {
      saveProgress(currentSlide, audioRef.current?.currentTime || 0);
      setCurrentSlide(prev => prev + 1);
      setIsPlaying(false);
    }
  };
  
  const previousSlide = () => {
    if (currentSlide > 1) {
      saveProgress(currentSlide, audioRef.current?.currentTime || 0);
      setCurrentSlide(prev => prev - 1);
      setIsPlaying(false);
    }
  };
  
  // Auto-save progress every 5 seconds
  useEffect(() => {
    if (!isPlaying || !supabase) return;
    const interval = setInterval(() => {
      if (audioRef.current) {
        saveProgress(currentSlide, audioRef.current.currentTime);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isPlaying, currentSlide, supabase]);
  
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white">
      {/* Header */}
      <div className="flex justify-between items-center p-4 border-b border-gray-700">
        <h1 className="text-xl font-bold">Course Player</h1>
        <div className="text-sm text-gray-400">
          Slide {currentSlide} of {slides.length}
        </div>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Slide Display */}
        <div className="flex-1 flex items-center justify-center bg-black p-8">
          {currentSlideData && (
            <img 
              src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/slides/${currentSlideData.image_path}`}
              alt={`Slide ${currentSlide}`}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>
        
        {/* Sidebar Controls */}
        <div className="w-80 bg-gray-800 p-6 flex flex-col gap-4 overflow-y-auto">
          {/* Audio Controls */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="font-bold mb-3">Audio Controls</h3>
            
            {currentSlideData?.audio_path ? (
              <>
                <div className="flex justify-center gap-2 mb-4">
                  <button 
                    onClick={() => rewind(10)} 
                    className="p-2 bg-gray-600 rounded hover:bg-gray-500"
                    disabled={loading || !supabase}
                  >
                    -10s
                  </button>
                  <button 
                    onClick={restartSlide} 
                    className="p-2 bg-gray-600 rounded hover:bg-gray-500"
                    disabled={loading || !supabase}
                  >
                    ↻
                  </button>
                  <button 
                    onClick={isPlaying ? pauseSlide : playSlide}
                    className="p-2 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-50"
                    disabled={loading || !audioUrl}
                  >
                    {isPlaying ? '❚❚' : '▶'}
                  </button>
                </div>
                
                {/* Progress Bar */}
                <div className="w-full bg-gray-600 h-2 rounded-full overflow-hidden">
                  <div 
                    className="bg-blue-500 h-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-1 text-center">
                  {formatTime(currentTime)} / {formatTime(currentSlideData?.duration_seconds || 0)}
                </div>
              </>
            ) : (
              <p className="text-gray-400 text-center py-4">No audio for this slide</p>
            )}
          </div>
          
          {/* Slide Navigation */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="font-bold mb-3">Slides</h3>
            <div className="grid grid-cols-5 gap-2 max-h-48 overflow-y-auto">
              {slides.map((slide) => {
                const isCompleted = progressMap.get(slide.slide_number)?.completed;
                return (
                  <button
                    key={slide.id}
                    onClick={() => {
                      saveProgress(currentSlide, audioRef.current?.currentTime || 0);
                      setCurrentSlide(slide.slide_number);
                      setIsPlaying(false);
                    }}
                    className={`aspect-square rounded text-sm font-bold ${
                      slide.slide_number === currentSlide 
                        ? 'bg-blue-600 text-white' 
                        : isCompleted
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                    }`}
                  >
                    {slide.slide_number}
                  </button>
                );
              })}
            </div>
          </div>
          
          {/* Navigation Buttons */}
          <div className="flex gap-2 mt-auto">
            <button 
              onClick={previousSlide}
              disabled={currentSlide === 1}
              className="flex-1 p-3 bg-gray-700 rounded-lg disabled:opacity-50 hover:bg-gray-600"
            >
              ← Previous
            </button>
            <button 
              onClick={nextSlide}
              disabled={currentSlide === slides.length}
              className="flex-1 p-3 bg-blue-600 rounded-lg disabled:opacity-50 hover:bg-blue-500"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
      
      {/* Hidden Audio Element */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={(e) => {
            const current = e.currentTarget.currentTime;
            const duration = currentSlideData?.duration_seconds || 1;
            setCurrentTime(current);
            setProgress((current / duration) * 100);
          }}
          onEnded={() => {
            setIsPlaying(false);
            saveProgress(currentSlide, currentSlideData?.duration_seconds || 0, true);
          }}
        />
      )}
    </div>
  );
}
