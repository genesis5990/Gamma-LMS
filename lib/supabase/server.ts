import { createPagesServerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export function createClient() {
  const cookieStore = cookies();

  // For App Router, we need to use the cookie store differently
  // The old auth-helpers-nextjs expects req/res for Pages Router
  // We'll create a minimal mock for the App Router context
  const req = {
    cookies: {
      get: (name: string) => {
        const cookie = cookieStore.get(name);
        return cookie ? { value: cookie.value } : undefined;
      },
    },
  } as any;

  const res = {
    setHeader: () => {},
    getHeader: () => {},
  } as any;

  return createPagesServerClient({ req, res });
}
