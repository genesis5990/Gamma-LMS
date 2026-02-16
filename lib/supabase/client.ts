import { createPagesBrowserClient } from '@supabase/auth-helpers-nextjs';

export function createClient() {
  return createPagesBrowserClient();
}
