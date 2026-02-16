'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AICourseCreator() {
  const [topic, setTopic] = useState('');
  const [numSlides, setNumSlides] = useState(10);
  const [textDensity, setTextDensity] = useState('medium');
  const [tone, setTone] = useState('educational');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [outline, setOutline] = useState<string[]>([]);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('AI is creating your course...');
    setOutline([]);

    try {
      const response = await fetch('/api/ai-create-course', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          numSlides,
          textDensity,
          tone,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(data.message);
        setOutline(data.outline || []);
        setTimeout(() => {
          router.push(`/admin/courses/${data.courseId}/audio`);
        }, 3000);
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('AI creation error:', error);
      setMessage('Failed to create AI course. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto bg-gradient-to-br from-purple-50 to-blue-50 rounded-lg shadow p-6 border border-purple-200">
      <div className="flex items-center gap-2 mb-6">
        <span className="text-2xl">✨</span>
        <h2 className="text-2xl font-bold text-gray-900">Create with AI</h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Course Topic
          </label>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g., Introduction to Blockchain Technology"
            required
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />
          <p className="text-sm text-gray-500 mt-1">
            Describe what you want to teach. AI will generate the course structure.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Number of Slides
            </label>
            <select
              value={numSlides}
              onChange={(e) => setNumSlides(parseInt(e.target.value))}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            >
              <option value={5}>5 slides</option>
              <option value={10}>10 slides</option>
              <option value={15}>15 slides</option>
              <option value={20}>20 slides</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Text Density
            </label>
            <select
              value={textDensity}
              onChange={(e) => setTextDensity(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            >
              <option value="brief">Brief</option>
              <option value="medium">Medium</option>
              <option value="extensive">Extensive</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tone
            </label>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            >
              <option value="educational">Educational</option>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="enthusiastic">Enthusiastic</option>
            </select>
          </div>
        </div>

        {message && (
          <div className={`p-4 rounded-lg ${
            message.includes('Error') || message.includes('error')
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {message}
          </div>
        )}

        {outline.length > 0 && (
          <div className="p-4 bg-white rounded-lg border">
            <h3 className="font-semibold mb-2">Generated Outline:</h3>
            <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
              {outline.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !topic}
          className="w-full py-3 px-6 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Creating...
            </>
          ) : (
            <>
              <span>✨</span> Create with AI
            </>
          )}
        </button>
      </form>

      <div className="mt-6 p-4 bg-blue-50 rounded-lg text-sm text-blue-700">
        <p className="font-medium mb-1">💡 Tips for best results:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Be specific about the topic (e.g., "Bitcoin fundamentals for beginners")</li>
          <li>5-10 slides works best for short courses</li>
          <li>You can upload custom slide images and audio after creation</li>
        </ul>
      </div>
    </div>
  );
}
