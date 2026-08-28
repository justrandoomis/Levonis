import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { 
  ArrowLeft, ArrowRight, MoreHorizontal, Mic, Smile, ShoppingBag, Plus, ChevronDown, X,
  Image as ImageIcon, Camera, Store as StoreIcon, Gift, MapPin, UserCircle, Wallet, Play, Square, Send
} from 'lucide-react';

type MessageType = 'text' | 'image' | 'voice' | 'product' | 'system';

interface Message {
  id: string;
  type: MessageType;
  sender: 'user' | 'merchant' | 'system';
  content?: string;
  time: string;
  image?: string;
  voiceDuration?: number;
  product?: {
    title: string;
    image: string;
    price: number;
    originalPrice?: number;
    specs?: string;
    store: string;
  };
}

export default function Chat() {
  const navigate = useNavigate();
  const { dir } = useLanguage();
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const merchantName = "tbNick_o1";
  const merchantStatus = dir === 'rtl' ? "متصل للتو" : "Just online";
  
  const suggestions = dir === 'rtl' ? [
    "وصني~ 🥳", "لقد اشتريت هذا 😋", "يناسبك 😉", "ما رأيك، هل يبدو جيداً؟"
  ] : [
    "Recommend~ 🥳", "I bought this 😋", "Suits you 😉", "What do you think?"
  ];

  const dummyProducts: any[] = [];
  const emojis = ['😀','😂','😅','😍','😊','😎','🤔','😭','👍','🙏','❤️','🔥','✨','🎉','💯'];
  const [messages, setMessages] = useState<Message[]>([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    let interval: any;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      setRecordingTime(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const getCurrentTime = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  };

  const handleSendMessage = () => {
    if (!inputText.trim()) return;
    const newMsg: Message = {
      id: Date.now().toString(),
      type: 'text',
      sender: 'user',
      content: inputText.trim(),
      time: getCurrentTime()
    };
    setMessages([...messages, newMsg]);
    setInputText("");
    setShowEmojiPicker(false);
    setIsPlusMenuOpen(false);
  };

  const handleSendVoice = () => {
    if (isRecording) {
      const newMsg: Message = {
        id: Date.now().toString(),
        type: 'voice',
        sender: 'user',
        voiceDuration: recordingTime,
        time: getCurrentTime()
      };
      setMessages([...messages, newMsg]);
      setIsRecording(false);
    } else {
      setIsRecording(true);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const newMsg: Message = {
          id: Date.now().toString(),
          type: 'image',
          sender: 'user',
          image: event.target?.result as string,
          time: getCurrentTime()
        };
        setMessages([...messages, newMsg]);
      };
      reader.readAsDataURL(file);
    }
    setIsPlusMenuOpen(false);
  };

  const handleSendProduct = (product: any) => {
    const newMsg: Message = {
      id: Date.now().toString(),
      type: 'product',
      sender: 'user',
      product: {
        ...product,
        specs: dir === 'rtl' ? "اختر مواصفات المنتج" : "Select Product Specs"
      },
      time: getCurrentTime()
    };
    setMessages([...messages, newMsg]);
    setShowProductPicker(false);
    setIsPlusMenuOpen(false);
  };

  const plusMenuOptions = [
    { 
      icon: ImageIcon, 
      label: dir === 'rtl' ? 'الألبوم' : 'Album',
      onClick: () => fileInputRef.current?.click()
    },
    { icon: Camera, label: dir === 'rtl' ? 'تصوير' : 'Camera', onClick: () => {} },
    { 
      icon: ShoppingBag, 
      label: dir === 'rtl' ? 'المنتجات' : 'Products',
      onClick: () => setShowProductPicker(true)
    },
    { icon: StoreIcon, label: dir === 'rtl' ? 'المتجر' : 'Store', onClick: () => {} },
    { icon: Gift, label: dir === 'rtl' ? 'مغلف أحمر' : 'Red Envelope', onClick: () => {} },
    { icon: MapPin, label: dir === 'rtl' ? 'الموقع' : 'Location', onClick: () => {} },
    { icon: UserCircle, label: dir === 'rtl' ? 'بطاقة شخصية' : 'Profile Card', onClick: () => {} },
    { icon: Wallet, label: dir === 'rtl' ? 'إرسال أموال' : 'Send Money', onClick: () => {} },
  ];

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#000000] min-h-screen flex flex-col font-sans text-[#333] dark:text-[#ccc]">
      <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
      
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-[#f2f2f2] dark:bg-[#000000] px-4 py-2 flex items-center justify-between border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 -ms-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white">
            {dir === 'rtl' ? <ArrowRight className="w-6 h-6" strokeWidth={2} /> : <ArrowLeft className="w-6 h-6" strokeWidth={2} />}
          </button>
          <div className="flex flex-col">
            <h1 className="font-bold text-lg leading-tight text-black dark:text-white">{merchantName}</h1>
            <span className="text-[11px] text-[#999]">{merchantStatus}</span>
          </div>
        </div>
        <button className="p-2 -me-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white">
          <MoreHorizontal className="w-6 h-6" strokeWidth={2} />
        </button>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-4 pt-20 pb-[160px] flex flex-col gap-6" onClick={() => { setIsPlusMenuOpen(false); setShowEmojiPicker(false); }}>
        
        {messages.map((msg, index) => {
          const isUser = msg.sender === 'user';
          
          if (msg.type === 'system') {
            return (
              <div key={msg.id}>
                {index > 0 && messages[index-1].time !== msg.time && (
                   <div className="text-center text-[11px] text-[#999] font-medium tracking-wide mb-6">{msg.time}</div>
                )}
                <div className="flex flex-col items-center justify-center mt-2 mb-2 gap-3">
                  <div className="flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center border-2 border-[#f2f2f2] dark:border-[#000000] z-10 overflow-hidden">
                      <img referrerPolicy="no-referrer" src="https://api.dicebear.com/7.x/bottts/svg?seed=user" alt="user" className="w-full h-full object-cover p-1 bg-[#e0e0e0] dark:bg-[#222]" />
                    </div>
                    <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center border-2 border-[#f2f2f2] dark:border-[#000000] -ms-3 z-0 overflow-hidden">
                      <img referrerPolicy="no-referrer" src="https://api.dicebear.com/7.x/bottts/svg?seed=merchant" alt="merchant" className="w-full h-full object-cover p-1 bg-[#e0e0e0] dark:bg-[#222]" />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 w-full max-w-[300px]">
                    <div className="h-[1px] flex-1 bg-[#d9d9d9] dark:bg-[#333]"></div>
                    <span className="text-[11px] text-[#666] font-medium">{dir === 'rtl' ? "نحن الآن أصدقاء" : "We are now friends"}</span>
                    <div className="h-[1px] flex-1 bg-[#d9d9d9] dark:bg-[#333]"></div>
                  </div>
                  <span className="text-[11px] text-[#b3b3b3] mt-0.5">
                    {dir === 'rtl' ? "لقد التقينا من خلال التطبيق، لنتواصل أكثر" : "We met through the app, let's keep in touch"}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <React.Fragment key={msg.id}>
              {/* Show time if first message or time changed significantly (simplified here) */}
              {(index === 0 || messages[index-1].time !== msg.time) && (
                <div className="text-center text-[11px] text-[#999] font-medium tracking-wide">{msg.time}</div>
              )}
              
              <div className={`flex items-start gap-3 ${isUser ? 'justify-end' : ''} ${index === messages.length - 1 ? 'mb-10' : ''}`}>
                
                {!isUser && (
                  <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden border border-black/5 dark:border-white/5">
                    <img referrerPolicy="no-referrer" src="https://api.dicebear.com/7.x/bottts/svg?seed=merchant" alt="avatar" className="w-full h-full object-cover p-1 bg-[#e0e0e0] dark:bg-[#222]" />
                  </div>
                )}
                
                {msg.type === 'text' && (
                  <div className={`${isUser ? 'bg-[#FFF0D6] dark:bg-[#3d3119] text-black dark:text-[#fde2b4] ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-white dark:bg-[#1a1a1a] text-black dark:text-white ltr:rounded-tl-sm rtl:ltr:rounded-tr-sm rtl:rounded-tl-sm'} px-4 py-3 rounded-2xl text-[15px] shadow-sm max-w-[75%] mt-1 whitespace-pre-wrap break-words`}>
                    {msg.content}
                  </div>
                )}

                {msg.type === 'voice' && (
                  <div className={`${isUser ? 'bg-[#FFF0D6] dark:bg-[#3d3119] text-black dark:text-[#fde2b4] ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-white dark:bg-[#1a1a1a] text-black dark:text-white ltr:rounded-tl-sm rtl:ltr:rounded-tr-sm rtl:rounded-tl-sm'} px-4 py-3 rounded-2xl text-[15px] shadow-sm max-w-[75%] mt-1 flex items-center gap-3 cursor-pointer`}>
                    <Play className="w-5 h-5 opacity-70 fill-current" />
                    <div className="flex gap-1">
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className="w-1 h-3 bg-current opacity-50 rounded-full"></div>
                      ))}
                    </div>
                    <span className="text-xs font-bold font-mono">{msg.voiceDuration}"</span>
                  </div>
                )}

                {msg.type === 'image' && (
                  <div className={`${isUser ? 'ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'ltr:rounded-tl-sm rtl:ltr:rounded-tr-sm rtl:rounded-tl-sm'} rounded-2xl shadow-sm max-w-[65%] mt-1 overflow-hidden border border-black/5 dark:border-white/5`}>
                    <img referrerPolicy="no-referrer" src={msg.image || undefined} alt="uploaded" className="w-full h-auto object-cover max-h-[300px]" />
                  </div>
                )}

                {msg.type === 'product' && msg.product && (
                  <div className="bg-white dark:bg-[#1a1a1a] rounded-2xl ltr:rounded-tr-sm rtl:rounded-tl-sm shadow-sm max-w-[85%] sm:max-w-[70%] overflow-hidden flex flex-col p-3 w-full mt-1">
                    <div className="flex gap-3">
                      <div className="w-[100px] h-[100px] rounded-lg bg-zinc-50 dark:bg-zinc-800 overflow-hidden shrink-0 border border-black/5 dark:border-white/5">
                        <img referrerPolicy="no-referrer" src={msg.product?.image || undefined} alt="product" className="w-full h-full object-cover mix-blend-multiply dark:mix-blend-normal" />
                      </div>
                      <div className="flex flex-col justify-between py-0.5 flex-1 min-w-0">
                        <div>
                          <h4 className="text-[13px] font-medium leading-[1.3] mb-2 line-clamp-2 text-black dark:text-white">
                            {msg.product.title}
                          </h4>
                          <button className="bg-[#fff3e6] dark:bg-[#2d1f11] text-[#ff5000] dark:text-[#ff9d5c] text-[10px] px-2 py-1 rounded-[4px] flex items-center gap-1 w-fit border border-[#ffe0cc] dark:border-transparent">
                            {msg.product.specs}
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="flex items-baseline gap-1 mt-3">
                          <span className="text-[#ff5000] dark:text-[#ff7633] text-xs font-bold">¥</span>
                          <span className="text-[#ff5000] dark:text-[#ff7633] text-xl font-bold">{Math.floor(msg.product.price)}<span className="text-sm font-bold">.{(msg.product.price % 1).toFixed(2).substring(2)}</span></span>
                          {msg.product.originalPrice && <span className="text-[#999] text-[11px] line-through ms-1">¥ {msg.product.originalPrice}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 pt-2.5 border-t border-[#f2f2f2] dark:border-white/5 flex items-center gap-1.5 text-[#999] text-[11px]">
                       <div className="w-3.5 h-3.5 rounded-full bg-[#ccc] dark:bg-zinc-700 flex items-center justify-center text-white">
                         <StoreIcon className="w-2.5 h-2.5" />
                       </div>
                       {msg.product.store}
                    </div>
                  </div>
                )}

                {isUser && (
                  <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden border border-black/5 dark:border-white/5">
                     <img referrerPolicy="no-referrer" src="https://api.dicebear.com/7.x/bottts/svg?seed=user" alt="avatar" className="w-full h-full object-cover p-1 bg-[#e0e0e0] dark:bg-[#222]" />
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Area */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#f7f7f7] dark:bg-[#0a0a0a] border-t border-black/5 dark:border-white/5 pb-safe transition-all duration-300">
        
        {/* Emoji Picker Overlay */}
        {showEmojiPicker && (
          <div className="px-4 py-3 bg-white dark:bg-[#1a1a1a] border-b border-black/5 dark:border-white/5">
            <div className="flex flex-wrap gap-2 justify-between">
              {emojis.map((emoji, i) => (
                <button key={i} className="text-2xl hover:scale-110 transition-transform" onClick={() => setInputText(prev => prev + emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Product Picker Overlay */}
        {showProductPicker && (
          <div className="px-4 py-4 bg-white dark:bg-[#1a1a1a] border-b border-black/5 dark:border-white/5 max-h-[300px] overflow-y-auto">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold text-sm text-black dark:text-white">{dir === 'rtl' ? 'اختر منتجاً' : 'Select Product'}</h3>
              <button onClick={() => setShowProductPicker(false)} className="text-zinc-500 hover:text-black dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {dummyProducts.map(p => (
                <button key={p.id} onClick={() => handleSendProduct(p)} className="flex gap-3 text-start bg-[#f7f7f7] dark:bg-[#222] p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                  <img referrerPolicy="no-referrer" src={p.image || undefined} className="w-16 h-16 rounded-lg object-cover" />
                  <div>
                    <h4 className="text-xs font-bold line-clamp-2 text-black dark:text-white mb-1">{p.title}</h4>
                    <span className="text-[#ff5000] text-sm font-bold">¥{p.price}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Suggestions */}
        {!showEmojiPicker && !showProductPicker && !isRecording && (
          <div className="flex overflow-x-auto px-4 py-3 gap-2.5 hide-scrollbar w-full">
            {suggestions.map((s, i) => (
              <button 
                key={i} 
                onClick={() => { setInputText(s); handleSendMessage(); }}
                className="whitespace-nowrap bg-white dark:bg-[#1a1a1a] border border-black/5 dark:border-white/10 px-3.5 py-1.5 rounded-full text-[13px] text-black dark:text-white shadow-sm font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Input Bar */}
        <div className="px-4 py-2.5 flex items-center gap-3">
          <button 
            className={`transition-colors ${isRecording ? 'text-red-500' : 'text-black dark:text-white hover:opacity-70'}`}
            onClick={handleSendVoice}
          >
            {isRecording ? <Square className="w-6 h-6 fill-current animate-pulse" /> : <Mic className="w-6 h-6" strokeWidth={1.5} />}
          </button>
          
          <div className="flex-1 bg-white dark:bg-[#1a1a1a] rounded-full h-10 flex items-center px-4 border border-black/5 dark:border-white/5 shadow-sm relative overflow-hidden">
            {isRecording ? (
              <div className="flex-1 flex items-center gap-2 text-red-500">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                <span className="text-sm font-bold font-mono">
                  {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                </span>
              </div>
            ) : (
              <input 
                type="text" 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder={dir === 'rtl' ? 'اكتب رسالة...' : 'Type a message...'}
                className="flex-1 bg-transparent border-none outline-none text-[15px] h-full text-black dark:text-white"
              />
            )}
            
            {!isRecording && (
              <button 
                className={`${showEmojiPicker ? 'text-[#ff5000]' : 'text-black dark:text-white'} hover:opacity-70 transition-colors ms-2`}
                onClick={() => {
                  setShowEmojiPicker(!showEmojiPicker);
                  setIsPlusMenuOpen(false);
                  setShowProductPicker(false);
                }}
              >
                <Smile className="w-6 h-6" strokeWidth={1.5} />
              </button>
            )}
          </div>
          
          {inputText.trim() ? (
             <button className="text-white bg-[#ff5000] p-1.5 rounded-full hover:opacity-90 transition-opacity" onClick={handleSendMessage}>
               <Send className="w-4 h-4 rtl:-scale-x-100" strokeWidth={2} />
             </button>
          ) : (
            <>
              <button 
                className="text-black dark:text-white hover:opacity-70 transition-opacity"
                onClick={() => {
                  setShowProductPicker(!showProductPicker);
                  setIsPlusMenuOpen(false);
                  setShowEmojiPicker(false);
                }}
              >
                <ShoppingBag className="w-6 h-6" strokeWidth={1.5} />
              </button>
              
              <button 
                className="text-black dark:text-white hover:opacity-70 transition-transform duration-300 relative"
                onClick={() => {
                  setIsPlusMenuOpen(!isPlusMenuOpen);
                  setShowEmojiPicker(false);
                  setShowProductPicker(false);
                }}
              >
                <div className={`transition-transform duration-300 ${isPlusMenuOpen ? 'rotate-45' : 'rotate-0'}`}>
                  <Plus className="w-6 h-6" strokeWidth={1.5} />
                </div>
                {!isPlusMenuOpen && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#ff5000] rounded-full border-[1.5px] border-[#f7f7f7] dark:border-[#0a0a0a]"></span>}
              </button>
            </>
          )}
        </div>
        
        {/* Plus Menu Grid */}
        {isPlusMenuOpen && (
          <div className="px-4 py-6 grid grid-cols-4 gap-y-6 gap-x-4 bg-[#f7f7f7] dark:bg-[#0a0a0a] animate-in slide-in-from-bottom-5 fade-in duration-300">
            {plusMenuOptions.map((opt, idx) => (
              <button key={idx} onClick={opt.onClick} className="flex flex-col items-center gap-2 group">
                <div className="w-[60px] h-[60px] bg-white dark:bg-[#1a1a1a] rounded-2xl flex items-center justify-center shadow-sm border border-black/5 dark:border-white/5 group-hover:scale-95 transition-transform">
                  <opt.icon className="w-7 h-7 text-black dark:text-white" strokeWidth={1.5} />
                </div>
                <span className="text-[11px] text-[#666] dark:text-[#999]">{opt.label}</span>
              </button>
            ))}
          </div>
        )}
        
        {!isPlusMenuOpen && <div className="h-4"></div>}
      </div>
    </div>
  );
}
