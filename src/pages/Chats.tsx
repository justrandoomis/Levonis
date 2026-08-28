import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Search, MessageSquare, X } from 'lucide-react';

interface ChatListItem {
  id: string;
  last_message: string | null;
  last_at: string | null;
  unread: number;
  other_username: string | null;
  other_name: string | null;
}

function formatChatTime(iso: string | null, lang: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const locale = lang === 'ar' ? 'ar' : lang === 'ku' ? 'ckb' : 'en-US';
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function Chats() {
  const navigate = useNavigate();
  const { t, dir, lang } = useLanguage();

  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ chats: ChatListItem[] }>('/api/chats')
      .then((data) => {
        if (!cancelled) setChats(data.chats || []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate('/auth');
          return;
        }
        setLoadError(
          (err instanceof ApiError && err.message) || (dir === 'rtl' ? 'تعذر تحميل المحادثات' : 'Failed to load chats')
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? chats.filter((c) => {
        const name = c.other_name || c.other_username || '';
        return name.toLowerCase().includes(q) || (c.last_message || '').toLowerCase().includes(q);
      })
    : chats;

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#000000] min-h-screen flex flex-col font-sans text-[#333] dark:text-[#ccc] pb-[100px]">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#f2f2f2] dark:bg-[#000000] px-4 py-3 flex items-center justify-between border-b border-black/5 dark:border-white/5">
        <h1 className="font-bold text-2xl text-black dark:text-white">
          {t('webCenter')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setShowSearch((s) => !s);
              setSearch('');
            }}
            className="p-2 -me-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white"
          >
            {showSearch ? <X className="w-6 h-6" strokeWidth={2} /> : <Search className="w-6 h-6" strokeWidth={2} />}
          </button>
        </div>
      </div>

      {showSearch && (
        <div className="px-4 py-2 bg-[#f2f2f2] dark:bg-[#000000] border-b border-black/5 dark:border-white/5">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={dir === 'rtl' ? 'بحث في المحادثات...' : 'Search chats...'}
            className="w-full bg-white dark:bg-[#1a1a1a] border border-black/5 dark:border-white/10 rounded-full py-2 px-4 text-sm outline-none text-black dark:text-white"
          />
        </div>
      )}

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-[50vh]">
            <div className="w-6 h-6 border-2 border-[#ff5000] border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#999]">
            <MessageSquare className="w-16 h-16 mb-4 opacity-50" strokeWidth={1} />
            <p>{loadError}</p>
          </div>
        ) : filtered.length > 0 ? (
          <div className="flex flex-col">
            {filtered.map((chat) => {
              const name = chat.other_name || chat.other_username || (dir === 'rtl' ? 'مستخدم' : 'User');
              return (
                <button
                  key={chat.id}
                  onClick={() => navigate(`/chat/${chat.id}`)}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-b border-black/5 dark:border-white/5 text-start w-full"
                >
                  <div className="relative">
                    <div className="w-14 h-14 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden border border-black/5 dark:border-white/5">
                      <span className="text-lg font-bold text-black dark:text-white">
                        {name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    {chat.unread > 0 && (
                      <span className="absolute top-0 end-0 bg-[#ff5000] text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-[#f2f2f2] dark:border-[#000000]">
                        {chat.unread > 99 ? '99+' : chat.unread}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-1">
                      <h3 className="text-[16px] font-bold text-black dark:text-white truncate flex items-center gap-1.5">
                        {name}
                      </h3>
                      <span className="text-[12px] text-[#999] whitespace-nowrap ms-2">{formatChatTime(chat.last_at, lang)}</span>
                    </div>
                    <p className="text-[14px] text-[#666] dark:text-[#999] truncate">
                      {chat.last_message || (dir === 'rtl' ? 'لا توجد رسائل بعد' : 'No messages yet')}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#999]">
            <MessageSquare className="w-16 h-16 mb-4 opacity-50" strokeWidth={1} />
            <p>{q ? (dir === 'rtl' ? 'لا توجد نتائج' : 'No results') : (dir === 'rtl' ? 'لا توجد محادثات' : 'No chats yet')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
