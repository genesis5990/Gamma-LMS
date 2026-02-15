'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GammaImporter() {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('0');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const router = useRouter();
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setProgress('Starting import...');
    
    try {
      const response = await fetch('/api/import-gamma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gammaUrl: url,
          title,
          description,
          price: parseFloat(price) || 0,
        }),
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setProgress(`Import successful! ${data.slideCount} slides imported.`);
        setTimeout(() => {
          router.push(`/admin/courses/${data.courseId}/audio`);
        }, 1500);
      } else {
        setProgress(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Import error:', error);
      setProgress('Import failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6">
      <h2 className="text-2xl font-bold mb-6">Import from Gamma</h2>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Gamma Share URL
          </label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://gamma.app/docs/..."
            required
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-sm text-gray-500 mt-1">
            Paste the share URL from your Gamma presentation
          </p>
        </div>
        
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
        
        {progress && (
          <div className="p-4 bg-blue-50 text-blue-700 rounded-lg">
            {progress}
          </div>
        )}
        
        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-6 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {loading ? 'Importing...' : 'Import Presentation'}
        </button>
      </form>
    </div>
  );
}
