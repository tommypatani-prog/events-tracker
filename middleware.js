import { verify, cookieOf } from './lib/auth.js';

// Охранник стоит перед всем: без пропуска страница даже не отдаётся.
// /api/telegram и /api/cron проверяют себя сами — своими секретами.
export const config = {
  matcher: ['/((?!api/login|api/telegram|api/cron|login.html|favicon.ico).*)']
};

export default async function middleware(req) {
  // Здесь приходит обычный Request — куки читаем из заголовка,
  // объекта req.cookies (как в Next.js) тут нет.
  const token = cookieOf(req.headers.get('cookie'), 'sd');
  const session = await verify(token, process.env.SESSION_SECRET);
  if (session) return;                       // пропуск в порядке — пускаем дальше
  return Response.redirect(new URL('/login.html', req.url), 302);
}
