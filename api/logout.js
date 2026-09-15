export const config = { runtime: 'edge' };

export default async function handler() {
  return new Response(null, {
    status: 302,
    headers: {
      location: '/login.html',
      'set-cookie': 'sd=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0'
    }
  });
}
