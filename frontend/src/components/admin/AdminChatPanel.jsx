// src/components/AdminChatPanel.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, Send, RefreshCw, Bot, ChevronLeft, Search } from 'lucide-react';
import axios from 'axios';

const API_URL =
  import.meta.env.VITE_API_URL || "https://nexustech-backend-b7dt.onrender.com";
const WS_URL =
  import.meta.env.VITE_WS_URL || "wss://nexustech-backend-b7dt.onrender.com";

function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Normalize a message from either WebSocket or HTTP into one consistent shape.
// HTTP rows:  { id, user_id, sender_name, is_admin(0/1), message, created_at }
// WS payload: { id, userId, senderName, isAdmin(bool), text, createdAt }
function normalizeMsg(raw) {
  return {
    id:         raw.id        ?? raw.message_id ?? `tmp_${Math.random()}`,
    is_admin:   raw.is_admin  !== undefined ? Number(raw.is_admin) : (raw.isAdmin ? 1 : 0),
    message:    raw.message   ?? raw.text ?? '',
    userId:     raw.user_id   ?? raw.userId  ?? null,
    senderName: raw.sender_name ?? raw.senderName ?? 'User',
    created_at: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
  };
}

export default function AdminChatPanel({ token }) {
  const [users,       setUsers]       = useState([]);
  const [activeUser,  setActiveUser]  = useState(null);
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState('');
  const [sending,     setSending]     = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [search,      setSearch]      = useState('');

  const wsRef     = useRef(null);
  const bottomRef = useRef(null);
  const activeRef = useRef(null); // stable ref for WS closure

  useEffect(() => { activeRef.current = activeUser; }, [activeUser]);

  // GET /api/admin/chats  ← was wrongly /api/admin/chat/users
  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/admin/chats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUsers(data);
    } catch (err) {
      console.error('fetchUsers error:', err);
    }
  }, [token]);

  // GET /api/admin/chats/:userId  ← was wrongly /api/admin/chat/:userId
  const fetchMessages = useCallback(async (userId) => {
    setLoadingMsgs(true);
    try {
      const { data } = await axios.get(`${API_URL}/api/admin/chats/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setMessages(data.map(normalizeMsg));
      setUsers(prev =>
        prev.map(u => u.user_id === userId ? { ...u, unread_count: 0 } : u)
      );
    } catch (err) {
      console.error('fetchMessages error:', err);
    } finally {
      setLoadingMsgs(false);
    }
  }, [token]);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));

    ws.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        if (raw.type !== 'chat_message') return;

        const msg = normalizeMsg(raw);
        // fromUserId: for user messages = the user's id
        //             for admin-sent messages = the target user's id
        const fromUserId = msg.userId;
        const isOpenConvo = activeRef.current?.user_id === fromUserId;

        // ── Update sidebar ──────────────────────────────────────────────────
        setUsers(prev => {
          const exists = prev.find(u => u.user_id === fromUserId);
          if (exists) {
            return prev.map(u => {
              if (u.user_id !== fromUserId) return u;
              return {
                ...u,
                last_message:    msg.message,
                last_message_at: msg.created_at,
                // Bump unread only for incoming user messages when convo isn't open
                unread_count: (!msg.is_admin && !isOpenConvo)
                  ? (Number(u.unread_count) || 0) + 1
                  : u.unread_count,
              };
            });
          }
          // Brand-new user — refresh list so they appear in sidebar
          fetchUsers();
          return prev;
        });

        // ── Append to open conversation ─────────────────────────────────────
        if (isOpenConvo) {
          setMessages(prev => {
            // Replace matching optimistic entry
            const optIdx = prev.findIndex(
              m => String(m.id).startsWith('opt_') && m.message === msg.message && Boolean(m.is_admin) === Boolean(msg.is_admin)
            );
            if (optIdx !== -1) {
              const next = [...prev]; next[optIdx] = msg; return next;
            }
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
      } catch (_) {}
    };

    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = () => ws.close();
  }, [token, fetchUsers]);

  useEffect(() => {
    fetchUsers();
    connectWS();
    return () => wsRef.current?.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeUser) fetchMessages(activeUser.user_id);
  }, [activeUser?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // POST /api/admin/chats/:userId/send  ← was wrongly POST /api/admin/chat/:userId
  const send = async () => {
    const text = input.trim();
    if (!text || sending || !activeUser) return;
    setSending(true);

    const optimisticId = `opt_${Date.now()}`;
    const optimistic = normalizeMsg({
      id:         optimisticId,
      is_admin:   1,
      message:    text,
      userId:     activeUser.user_id,
      senderName: 'Admin',
      created_at: new Date().toISOString(),
    });
    setMessages(prev => [...prev, optimistic]);
    setInput('');

    try {
      await axios.post(
        `${API_URL}/api/admin/chats/${activeUser.user_id}/send`,
        { message: text },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Server broadcasts via WS → normalizeMsg will replace the optimistic entry
    } catch {
      setMessages(prev => prev.filter(m => m.id !== optimisticId));
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const filteredUsers = users.filter(u =>
    u.username?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  const totalUnread = users.reduce((s, u) => s + (Number(u.unread_count) || 0), 0);

  return (
    <div className="flex h-[calc(100vh-140px)] bg-[#0a0a0d] rounded-2xl border border-white/10 overflow-hidden">

      {/* ── Left: user list ── */}
      <div className={`flex flex-col border-r border-white/10 transition-all ${
        activeUser ? 'hidden md:flex md:w-72' : 'flex w-full md:w-72'
      }`}>
        <div className="p-4 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageCircle size={16} className="text-blue-400" />
              <span className="font-black text-white text-sm">Live Chat</span>
              {totalUnread > 0 && (
                <span className="bg-red-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded-full">
                  {totalUnread}
                </span>
              )}
            </div>
            <button
              onClick={fetchUsers}
              className="p-1.5 hover:bg-white/10 rounded-lg text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-2.5 text-gray-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users…"
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-2 text-white text-xs placeholder-gray-600 focus:border-blue-500/50 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredUsers.length === 0 ? (
            <div className="text-center py-12 text-gray-600">
              <MessageCircle size={32} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            filteredUsers.map(u => (
              <button
                key={u.user_id}
                onClick={() => setActiveUser(u)}
                className={`w-full flex items-start gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left border-b border-white/5 ${
                  activeUser?.user_id === u.user_id
                    ? 'bg-blue-500/10 border-l-2 border-l-blue-500'
                    : ''
                }`}
              >
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-black flex-shrink-0">
                  {u.username?.slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-white font-bold text-xs truncate">{u.username}</p>
                    <span className="text-gray-600 text-[10px] flex-shrink-0 ml-1">
                      {formatDate(u.last_message_at)}
                    </span>
                  </div>
                  <p className="text-gray-500 text-[11px] truncate mt-0.5">{u.last_message}</p>
                </div>
                {Number(u.unread_count) > 0 && (
                  <span className="flex-shrink-0 bg-red-500 text-white text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center mt-1">
                    {u.unread_count}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: conversation ── */}
      {activeUser ? (
        <div className="flex-1 flex flex-col">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.02] flex-shrink-0">
            <button
              onClick={() => setActiveUser(null)}
              className="md:hidden p-1.5 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-black flex-shrink-0">
              {activeUser.username?.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p className="text-white font-black text-sm">{activeUser.username}</p>
              <p className="text-gray-500 text-xs">{activeUser.email}</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loadingMsgs ? (
              <div className="flex justify-center py-12">
                <div className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center py-12 text-gray-600">
                <MessageCircle size={32} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex gap-2 ${msg.is_admin ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-1 text-xs font-black ${
                    msg.is_admin
                      ? 'bg-gradient-to-br from-blue-500 to-cyan-500 text-white'
                      : 'bg-gradient-to-br from-purple-500 to-pink-500 text-white'
                  }`}>
                    {msg.is_admin
                      ? <Bot size={12} />
                      : activeUser.username?.slice(0, 1).toUpperCase()}
                  </div>
                  <div className={`max-w-[70%] flex flex-col ${msg.is_admin ? 'items-end' : 'items-start'}`}>
                    <div className={`px-3 py-2 rounded-2xl text-sm ${
                      msg.is_admin
                        ? 'bg-blue-600 text-white rounded-tr-none'
                        : 'bg-white/5 border border-white/10 text-gray-200 rounded-tl-none'
                    }`}>
                      {msg.message}
                    </div>
                    <span className="text-[10px] text-gray-600 mt-0.5 px-1">
                      {formatTime(msg.created_at)}
                    </span>
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div className="p-3 border-t border-white/10 flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={`Reply to ${activeUser.username}…`}
              rows={1}
              style={{ resize: 'none' }}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white placeholder-gray-600 text-sm focus:border-blue-500/50 focus:outline-none max-h-24 overflow-y-auto"
            />
            <button
              onClick={send}
              disabled={!input.trim() || sending}
              className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-xl text-white transition-all flex-shrink-0"
            >
              {sending
                ? <RefreshCw size={16} className="animate-spin" />
                : <Send size={16} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 hidden md:flex items-center justify-center text-gray-600 flex-col gap-3">
          <MessageCircle size={48} className="opacity-20" />
          <p className="font-bold">Select a conversation</p>
          <p className="text-sm text-gray-700">Pick a user from the left to start chatting</p>
        </div>
      )}
    </div>
  );
}