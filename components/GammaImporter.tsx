'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GammaImporter() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('0');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const router = useRouter();
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('Creating course...');
    
    try {
      const response = await fetch('/api/import-gamma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          price: parseFloat(price) || 0,
        }),
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setMessage('Course created! Redirecting to upload slides...');
        setTimeout(() => {
          router.push(`/admin/courses/${data.courseId}/audio`);
        }, 1000);
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Import error:', error);
      setMessage('Failed to create course. Please try again.');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6">
      <h2 className="text-2xl font-bold mb-6">Create New Course</h2>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Course Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My Awesome Course"
            required
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Course description..."
            rows={3}
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Price (USD)
          </label>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            min="0"
            step="0.01"
            placeholder="0.00"
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-sm text-gray-500 mt-1">
            Set to 0 for free course
          </p>
        </div>
        
        {message && (
          <div className="p-4 bg-blue-50 text-blue-700 rounded-lg">
            {message}
          </div>
        )}
        
        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-6 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {loading ? 'Creating...' : 'Create Course'}
        </button>
      </form>
    </div>
  );
}
