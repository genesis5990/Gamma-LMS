import { createPagesBrowserClient } from '@supabase/auth-helpers-nextjs';
import { useMemo } from 'react';

export function createClient() {
  return createPagesBrowserClient();
}

// Hook for use in client components
export function useSupabase() {
  return useMemo(() => createPagesBrowserClient(), []);
}
