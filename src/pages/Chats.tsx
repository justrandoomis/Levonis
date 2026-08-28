import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { 
  ArrowLeft, ArrowRight, Search, MoreVertical, MessageSquare
} from 'lucide-react';

export default function Chats() {
  const navigate = useNavigate();
  const { t, dir } = useLanguage();
  
  const conversations: any[] = [];

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#000000] min-h-screen flex flex-col font-sans text-[#333] dark:text-[#ccc] pb-[100px]">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#f2f2f2] dark:bg-[#000000] px-4 py-3 flex items-center justify-between border-b border-black/5 dark:border-white/5">
        <h1 className="font-bold text-2xl text-black dark:text-white">
          {t('webCenter')}
        </h1>
        <div className="flex items-center gap-2">
          <button className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white">
            <Search className="w-6 h-6" strokeWidth={2} />
          </button>
          <button className="p-2 -me-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white">
            <MoreVertical className="w-6 h-6" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length > 0 ? (
          <div className="flex flex-col">
            {conversations.map((chat) => (
              <button 
                key={chat.id}
                onClick={() => navigate(`/chat/${chat.id}`)}
                className="flex items-center gap-4 px-4 py-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-b border-black/5 dark:border-white/5 text-start w-full"
              >
                <div className="relative">
                  <div className="w-14 h-14 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden border border-black/5 dark:border-white/5">
                    <img referrerPolicy="no-referrer" src={chat.avatar || undefined} alt="avatar" className="w-full h-full object-cover p-1.5 bg-[#e0e0e0] dark:bg-[#222]" />
                  </div>
                  {chat.unread > 0 && (
                    <span className="absolute top-0 end-0 bg-[#ff5000] text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-[#f2f2f2] dark:border-[#000000]">
                      {chat.unread}
                    </span>
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center mb-1">
                    <h3 className="text-[16px] font-bold text-black dark:text-white truncate flex items-center gap-1.5">
                      {chat.name}
                      {chat.isOfficial && (
                        <span className="bg-[#ff5000]/10 text-[#ff5000] text-[10px] px-1.5 py-0.5 rounded font-bold">
                          {dir === 'rtl' ? 'رسمي' : 'Official'}
                        </span>
                      )}
                    </h3>
                    <span className="text-[12px] text-[#999] whitespace-nowrap ms-2">{chat.time}</span>
                  </div>
                  <p className="text-[14px] text-[#666] dark:text-[#999] truncate">
                    {chat.lastMessage}
                  </p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#999]">
            <MessageSquare className="w-16 h-16 mb-4 opacity-50" strokeWidth={1} />
            <p>{dir === 'rtl' ? 'لا توجد محادثات' : 'No chats yet'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
