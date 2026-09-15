// Тонкая обёртка над Telegram Bot API. Разметка — HTML, всё пользовательское экранируем.
const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function call(method, body) {
  const r = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) console.error('telegram', method, data.description || r.status);
  return data;
}

export const send = (chat_id, text, extra = {}) =>
  call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

export const typing = (chat_id) => call('sendChatAction', { chat_id, action: 'typing' });

export const answerCallback = (id, text) =>
  call('answerCallbackQuery', { callback_query_id: id, text: text || '' });

export const editText = (chat_id, message_id, text, extra = {}) =>
  call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', ...extra });

export const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });

// Скачать файл из телеграма. Лимит Bot API — 20 МБ.
export async function download(fileId) {
  const info = await call('getFile', { file_id: fileId });
  if (!info.ok) return null;
  const path = info.result.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!r.ok) return null;
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, path, size: info.result.file_size || buffer.length };
}
