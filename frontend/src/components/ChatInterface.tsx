"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Menu, Plus, Bot, Loader2, MessageSquare, X, Globe, Building, HelpCircle, BookOpen, Briefcase, Download, Ticket, ThumbsUp, ThumbsDown, RotateCcw, Copy, Trash2, CheckCircle2, FileText, AlertTriangle, Sparkles } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRouter } from "next/navigation";
import { exportAsMarkdown, exportAsPlainText, exportAsPDF } from "../lib/chatExport";
import { apiFetch, apiJson, type Citation, type SourceType, type AskResponse } from "../lib/api";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

type Message = {
    id?: number;
    role: "user" | "assistant";
    content: string;
    citations?: Citation[];
    confidence?: number | null;
    source_type?: SourceType | null;
};

type ChatSession = {
    id: number;
    title: string;
    created_at: string;
};

const SUGGESTED_QUERIES = [
    { text: "How do I configure automatic email routing for support tickets?", icon: Briefcase, label: "Ticket routing" },
    { text: "What is the standard escalation policy for urgent complaints?", icon: BookOpen, label: "Escalation policy" },
    { text: "Show me the refund approval setup checklist.", icon: Building, label: "Refund checklist" },
    { text: "Reset instructions for account locks and password resets.", icon: HelpCircle, label: "Account lock reset" },
];

const PLACEHOLDERS = [
    "Ask Valar a support question...",
    "How do I troubleshoot...",
    "Show me safety procedures for...",
    "What is the policy for..."
];

interface ChatInterfaceProps {
    role?: string | null;
    handleLogout?: () => void;
}

/** Retrieval confidence, banded so a weak match never reads as authoritative. */
function ConfidenceBadge({ value }: { value: number }) {
    const pct = Math.round(value * 100);
    const band =
        value >= 0.7 ? { label: "High confidence", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" } :
        value >= 0.4 ? { label: "Moderate confidence", cls: "bg-amber-500/10 text-amber-400 border-amber-500/25" } :
                       { label: "Low confidence", cls: "bg-red-500/10 text-red-400 border-red-500/25" };

    return (
        <span
            title={`Retrieval confidence ${pct}% — how strongly the cited documents matched your question.`}
            className={cn("text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md border shrink-0", band.cls)}
        >
            {band.label} · {pct}%
        </span>
    );
}

export default function ChatInterface({ role, handleLogout }: ChatInterfaceProps = {}) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const router = useRouter();

    const [currentPlaceholder, setCurrentPlaceholder] = useState("");
    const [placeholderIndex, setPlaceholderIndex] = useState(0);
    const [isDeleting, setIsDeleting] = useState(false);

    // Support Features State (Placeholder UI & LocalStorage mock)
    const [searchQuery, setSearchQuery] = useState("");
    const [isTicketModalOpen, setIsTicketModalOpen] = useState(false);
    const [ticketSubject, setTicketSubject] = useState("");
    const [ticketDescription, setTicketDescription] = useState("");
    const [ticketPriority, setTicketPriority] = useState("Medium");
    const [ticketSuccess, setTicketSuccess] = useState(false);
    const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
    const [sessionToDelete, setSessionToDelete] = useState<number | null>(null);

    // message_id -> "helpful" | "not_helpful", so the UI reflects what was saved
    const [feedbackGiven, setFeedbackGiven] = useState<Record<number, string>>({});
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

    // message_id -> generated follow-up questions (cached server-side)
    const [followUps, setFollowUps] = useState<Record<number, string[]>>({});
    const [followUpsLoading, setFollowUpsLoading] = useState<number | null>(null);

    const confirmDeleteSession = async (sessionId: number) => {
        try {
            const res = await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
            if (res.ok) {
                if (currentSessionId === sessionId) {
                    setMessages([]);
                    setCurrentSessionId(null);
                }
                fetchSessions();
            } else {
                throw new Error("Failed to delete session");
            }
        } catch (err) {
            console.error(err);
            alert("Failed to delete this conversation. Please try again.");
        }
    };

    const submitFeedback = async (messageId: number | undefined, rating: "helpful" | "not_helpful") => {
        if (!messageId) return;
        const previous = feedbackGiven[messageId];
        setFeedbackGiven(prev => ({ ...prev, [messageId]: rating }));  // optimistic
        try {
            await apiJson(`/messages/${messageId}/feedback`, {
                method: 'POST',
                body: JSON.stringify({ rating }),
            });
        } catch (err) {
            console.error("Failed to save feedback", err);
            setFeedbackGiven(prev => {
                const next = { ...prev };
                if (previous) next[messageId] = previous;
                else delete next[messageId];
                return next;
            });
        }
    };

    useEffect(() => {
        const timeoutContext = setTimeout(() => {
            const fullText = PLACEHOLDERS[placeholderIndex];

            if (!isDeleting) {
                setCurrentPlaceholder(fullText.substring(0, currentPlaceholder.length + 1));
                if (currentPlaceholder.length === fullText.length) {
                    setTimeout(() => setIsDeleting(true), 1500);
                }
            } else {
                setCurrentPlaceholder(fullText.substring(0, currentPlaceholder.length - 1));
                if (currentPlaceholder.length === 0) {
                    setIsDeleting(false);
                    setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDERS.length);
                }
            }
        }, isDeleting ? 30 : 50);

        return () => clearTimeout(timeoutContext);
    }, [currentPlaceholder, isDeleting, placeholderIndex]);

    useEffect(() => {
        if (window.innerWidth < 768) {
            setSidebarOpen(false);
        }
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Fetch follow-ups for the newest answer once it has rendered. Kept out of
    // the /ask response so the answer is never held back waiting on them.
    // `attempted` guarantees one request per message even if it fails —
    // without it, a failing endpoint would be retried on every render.
    const followUpsAttempted = useRef<Set<number>>(new Set());

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant" || !last.id) return;

        const messageId = last.id;
        if (followUpsAttempted.current.has(messageId)) return;
        followUpsAttempted.current.add(messageId);

        setFollowUpsLoading(messageId);
        apiJson<{ follow_ups: string[] }>(`/messages/${messageId}/followups`)
            .then(({ follow_ups }) => setFollowUps(prev => ({ ...prev, [messageId]: follow_ups })))
            .catch(err => {
                console.error("Failed to load follow-ups", err);
                setFollowUps(prev => ({ ...prev, [messageId]: [] }));
            })
            .finally(() => setFollowUpsLoading(curr => (curr === messageId ? null : curr)));
    }, [messages]);

    const fetchSessions = async () => {
        try {
            const data = await apiJson<ChatSession[]>('/sessions');
            setSessions(data);
        } catch (error) {
            console.error("Failed to fetch sessions", error);
        }
    };

    const loadSession = async (sessionId: number) => {
        setCurrentSessionId(sessionId);
        setIsLoading(true);
        try {
            const data = await apiJson<Message[]>(`/sessions/${sessionId}/messages`);
            setMessages(data.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                citations: m.citations ?? [],
                confidence: m.confidence,
                source_type: m.source_type,
            })));
        } catch (error) {
            console.error("Failed to load session", error);
        } finally {
            setIsLoading(false);
            if (window.innerWidth < 768) {
                setSidebarOpen(false);
            }
        }
    };

    useEffect(() => {
        fetchSessions();
    }, []);

    const handleSubmit = async (e?: React.FormEvent, overrideInput?: string) => {
        e?.preventDefault();
        const textToSubmit = overrideInput !== undefined ? overrideInput : input;
        if (!textToSubmit.trim() || isLoading) return;

        const userMessage = textToSubmit.trim();
        setInput("");
        setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
        setIsLoading(true);

        try {
            let activeSessionId = currentSessionId;

            if (!activeSessionId) {
                const newSession = await apiJson<ChatSession>('/sessions', { method: 'POST' });
                activeSessionId = newSession.id;
                setCurrentSessionId(activeSessionId);
            }

            const data = await apiJson<AskResponse>(`/sessions/${activeSessionId}/ask`, {
                method: 'POST',
                body: JSON.stringify({ question: userMessage }),
            });

            setMessages((prev) => [
                ...prev,
                {
                    id: data.message_id,
                    role: "assistant",
                    content: data.answer,
                    citations: data.citations ?? [],
                    confidence: data.confidence,
                    source_type: data.source_type,
                },
            ]);

            fetchSessions();
        } catch (error) {
            console.error(error);
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: error instanceof Error && error.message !== "Unauthorized"
                        ? `Sorry, something went wrong: ${error.message}`
                        : "Sorry, I had trouble connecting to the server. Please check your backend connection.",
                    source_type: "none",
                },
            ]);
        } finally {
            setIsLoading(false);
        }
    };

    const renderMessageContent = (msg: Message) => {
        const mainContent = msg.content;
        const citations = msg.citations ?? [];
        const sourceType = msg.source_type ?? null;
        const confidence = msg.confidence;

        return (
            <div className="flex flex-col w-full min-w-0">
                {/* Provenance banner — a web answer must never look like plant documentation */}
                {sourceType === "web" && (
                    <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-200/90">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                        <p className="text-xs leading-relaxed">
                            <span className="font-semibold">Not from your document library.</span>{" "}
                            Nothing in the indexed corpus matched, so this was answered from public
                            web sources. Verify before acting on it.
                        </p>
                    </div>
                )}

                {sourceType === "faq" && (
                    <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/25 text-blue-200/90">
                        <Sparkles size={13} className="shrink-0 text-blue-400" />
                        <p className="text-xs font-medium">Curated answer from your FAQ library.</p>
                    </div>
                )}

                <div className="flex-1 text-[15px] leading-relaxed break-words mt-1.5 md:mt-2 text-gray-200 space-y-4 w-full">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            ul: (props) => <ul className="list-disc pl-6 space-y-1 mb-4" {...props} />,
                            ol: (props) => <ol className="list-decimal pl-6 space-y-1 mb-4" {...props} />,
                            li: (props) => <li className="pl-1 marker:text-gray-500" {...props} />,
                            h1: (props) => <h1 className="text-2xl font-bold mt-6 mb-3 text-white" {...props} />,
                            h2: (props) => <h2 className="text-xl font-bold mt-5 mb-3 text-white pb-1 border-b border-white/10" {...props} />,
                            h3: (props) => <h3 className="text-lg font-bold mt-4 mb-2 text-white" {...props} />,
                            p: (props) => <p className="mb-4 last:mb-0 leading-relaxed" {...props} />,
                            a: (props) => <a className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors" target="_blank" rel="noreferrer" {...props} />,
                            code: ({ className, children, ...props }) => {
                                const match = /language-(\w+)/.exec(className || '')
                                return match ? (
                                    <pre className="block bg-[#121212] p-4 rounded-xl text-sm font-mono my-4 overflow-x-auto border border-white/5 shadow-inner max-w-full">
                                        <code className={cn("text-gray-300", className)} {...props as any}>
                                            {children}
                                        </code>
                                    </pre>
                                ) : (
                                    <code className="bg-white/10 rounded-md px-1.5 py-0.5 text-[0.9em] font-mono text-purple-300" {...props as any}>
                                        {children}
                                    </code>
                                )
                            },
                            strong: (props) => <strong className="font-semibold text-white" {...props} />,
                            blockquote: (props) => <blockquote className="border-l-2 border-purple-500/50 pl-4 py-1 italic text-gray-400 my-4 bg-purple-500/5 rounded-r-lg" {...props} />,
                            table: (props) => <div className="w-full overflow-x-auto my-4 max-w-full"><table className="w-full text-sm text-left border-collapse border border-white/10 rounded-lg overflow-hidden" {...props} /></div>,
                            th: (props) => <th className="bg-[#2f2f2f] p-3 border-b border-white/10 font-semibold text-gray-200" {...props} />,
                            td: (props) => <td className="p-3 border-b border-white/5 last:border-0" {...props} />,
                        }}
                    >
                        {mainContent}
                    </ReactMarkdown>
                </div>

                {citations.length > 0 && (
                    <div className="w-full mt-5 border-t border-white/10 pt-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-semibold text-gray-400 flex items-center gap-1.5 uppercase tracking-wider">
                                {sourceType === "web"
                                    ? <Globe size={13} className="text-amber-400" />
                                    : <FileText size={13} className="text-emerald-400" />}
                                {sourceType === "web" ? "Web sources" : "Sources from your documents"}
                            </div>
                            {typeof confidence === "number" && sourceType === "documents" && (
                                <ConfidenceBadge value={confidence} />
                            )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {citations.map((c) => {
                                const label = c.page !== null && c.page !== undefined
                                    ? `${c.document} · p.${c.page + 1}`
                                    : c.document;

                                const inner = (
                                    <>
                                        <div className="flex items-center gap-2 text-xs min-w-0">
                                            <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-[9px] text-gray-300 font-semibold shrink-0 group-hover:bg-white/20 transition-colors">
                                                {c.index}
                                            </div>
                                            <span className="text-[13px] font-medium text-gray-200 truncate flex-1">
                                                {label}
                                            </span>
                                            {c.score > 0 && (
                                                <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
                                                    {Math.round(c.score * 100)}%
                                                </span>
                                            )}
                                        </div>
                                        {c.snippet && (
                                            <p className="text-[11px] text-gray-500 mt-1.5 line-clamp-2 leading-relaxed">
                                                {c.snippet}
                                            </p>
                                        )}
                                    </>
                                );

                                return c.url ? (
                                    <a
                                        key={c.index}
                                        href={c.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="group flex flex-col bg-[#1c1c1c] hover:bg-[#2a2a2a] border border-white/10 hover:border-white/20 rounded-xl px-3 py-2.5 transition-all text-left w-full shadow-sm overflow-hidden"
                                    >
                                        {inner}
                                    </a>
                                ) : (
                                    <div
                                        key={c.index}
                                        title={c.snippet}
                                        className="group flex flex-col bg-[#1c1c1c] border border-white/10 rounded-xl px-3 py-2.5 text-left w-full shadow-sm overflow-hidden"
                                    >
                                        {inner}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Grounded answer with no usable sources — say so rather than implying authority */}
                {citations.length === 0 && sourceType === "none" && (
                    <div className="mt-4 text-[11px] text-gray-500 flex items-center gap-1.5">
                        <AlertTriangle size={12} className="text-gray-600" />
                        No supporting document was found for this answer.
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full w-full bg-[#212121] text-gray-100 font-sans overflow-hidden">
            {/* Mobile Overlay */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/70 z-30 md:hidden transition-opacity"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div
                className={cn(
                    "fixed inset-y-0 left-0 z-40 w-[260px] bg-[#171717] transform transition-all duration-300 ease-in-out md:relative md:translate-x-0 flex flex-col border-r border-white/5",
                    !sidebarOpen && "-translate-x-full md:w-0 md:opacity-0 md:border-none overflow-hidden"
                )}
            >
                <div className="flex flex-col h-full p-3 w-[260px]">
                    <div className="flex items-center justify-between mb-4 md:hidden text-gray-400 px-1 pt-1">
                        <span className="font-semibold text-white">Menu</span>
                        <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-white/10 rounded-md transition-colors" title="Close Sidebar">
                            <X size={20} />
                        </button>
                    </div>

                    <button
                        onClick={() => {
                            setMessages([]);
                            setCurrentSessionId(null);
                            if (window.innerWidth < 768) setSidebarOpen(false);
                        }}
                        className="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-white/5 transition-colors text-sm text-white border border-white/5 shadow-sm mb-4"
                    >
                        <Plus size={16} />
                        New chat
                    </button>

                    {/* Search Bar */}
                    <div className="mb-4 shrink-0 px-1">
                        <input
                            type="text"
                            placeholder="Search conversations..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full text-xs p-2.5 bg-white/5 border border-white/10 rounded-lg focus:outline-none text-white focus:border-white/20 transition-all font-sans placeholder-gray-500"
                        />
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
                        <div className="text-xs font-semibold text-gray-500 px-3 py-2 mb-1">Recent Chats</div>
                        {sessions.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-gray-500 italic">No previous chats</div>
                        ) : (
                            sessions
                                .filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
                                .map((session) => (
                                    <div
                                        key={session.id}
                                        onClick={() => loadSession(session.id)}
                                        className={cn(
                                            "group px-3 py-2.5 text-sm truncate rounded-lg cursor-pointer transition-all mb-1 flex items-center gap-3 border",
                                            currentSessionId === session.id
                                                ? "bg-white/10 text-white font-medium border-white/10 shadow-sm"
                                                : "text-gray-300 hover:bg-white/5 border-transparent"
                                        )}
                                    >
                                        <MessageSquare size={14} className={currentSessionId === session.id ? "text-white" : "text-gray-500"} />
                                        <span className="truncate flex-1">{session.title}</span>
                                        
                                        <button 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSessionToDelete(session.id);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded text-gray-400 hover:text-red-400 transition-all shrink-0"
                                            title="Delete Session"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))
                        )}
                    </div>

                    {/* Support Status & Help Indicators */}
                    <div className="border-t border-white/5 pt-3 mt-2 space-y-2">
                        <div className="px-3 py-2 flex items-center justify-between text-[11px] text-gray-400 bg-white/5 rounded-lg border border-white/5">
                            <span className="flex items-center gap-1.5 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                Support System
                            </span>
                            <span className="text-gray-400 font-semibold uppercase text-[9px] tracking-wider bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">Ready</span>
                        </div>

                        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center text-white font-bold text-sm shadow-lg">
                                U
                            </div>
                            <div className="text-sm font-medium text-gray-200">User</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col h-full relative w-full overflow-x-hidden">
                {/* Header */}
                <div className="sticky top-0 z-30 flex items-center justify-between p-3 text-gray-200 bg-[#212121]/90 backdrop-blur-md border-b border-white/5 w-full">
                    <div className="flex items-center">
                        <button
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            className="p-2 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
                            title="Toggle Sidebar"
                        >
                            <Menu size={20} />
                        </button>
                        <span className="ml-3 font-semibold text-base text-gray-100 flex items-center gap-2">
                            <Bot size={18} className="text-purple-400 font-bold" />
                             Valar - Support Copilot
                        </span>
                    </div>

                    {/* Quick Support Actions */}
                    <div className="flex items-center gap-2">
                        {role === 'manager' && (
                            <button
                                onClick={() => router.push('/ops_admin')}
                                className="bg-white/10 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-white/20 transition-all border border-white/10"
                            >
                                Support Dashboard
                            </button>
                        )}

                        {messages.length > 0 && (
                            <div className="relative">
                                <button
                                    onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
                                    className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/15 rounded-lg text-gray-300 hover:text-white text-xs font-medium transition-all flex items-center gap-1.5"
                                    title="Export Session"
                                >
                                    <Download size={14} />
                                    Export
                                </button>
                                
                                {isExportMenuOpen && (
                                    <div className="absolute right-0 top-10 w-44 bg-[#1e1e1e] border border-white/10 rounded-xl shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                                        <button 
                                            onClick={() => { exportAsMarkdown(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                        >
                                            <Download size={11} className="text-gray-500" />
                                            Markdown (.md)
                                        </button>
                                        <button 
                                            onClick={() => { exportAsPDF(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                        >
                                            <Download size={11} className="text-gray-500" />
                                            PDF Document (.pdf)
                                        </button>
                                        <button 
                                            onClick={() => { exportAsPlainText(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                                        >
                                            <Download size={11} className="text-gray-500" />
                                            Plain Text (.txt)
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                        
                        <button
                            onClick={() => setIsTicketModalOpen(true)}
                            className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-[0_0_15px_rgba(147,51,234,0.15)]"
                            title="Raise Support Ticket"
                        >
                            <Ticket size={14} />
                            File Ticket
                        </button>

                        {handleLogout && (
                            <button
                                onClick={handleLogout}
                                className="bg-red-500/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-500 hover:text-white transition-all"
                            >
                                Logout
                            </button>
                        )}
                    </div>
                </div>

                {/* Messages Area */}
                {messages.length > 0 && (
                    <div className="flex-1 overflow-y-auto custom-scrollbar w-full flex flex-col items-center">
                        <div className="flex flex-col w-full max-w-3xl pb-4 pt-4 px-4 md:px-0">
                            {messages.map((msg, idx) => (
                                <div key={idx} className={cn("flex w-full mt-6 first:mt-0", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                    {msg.role === 'user' ? (
                                        <div className="max-w-[85%] md:max-w-[75%] bg-[#2f2f2f] text-gray-100 rounded-3xl px-5 py-3.5 shadow-sm text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                                            {msg.content}
                                        </div>
                                    ) : (
                                        <div className="flex gap-4 w-full">
                                            <div className="w-8 h-8 md:w-9 md:h-9 bg-white rounded-full flex items-center justify-center text-[#212121] flex-shrink-0 mt-1 shadow-sm border border-white/10">
                                                <Bot size={18} />
                                            </div>
                                            <div className="flex-1 flex flex-col min-w-0">
                                                {renderMessageContent(msg)}

                                                {/* Assistant Message Actions & Feedback */}
                                                <div className="flex flex-wrap items-center justify-between mt-3 text-gray-500 border-t border-white/5 pt-2 gap-2">
                                                    <div className="flex items-center gap-4">
                                                        <button
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(msg.content);
                                                                setCopiedIdx(idx);
                                                                setTimeout(() => setCopiedIdx(null), 2000);
                                                            }}
                                                            className="text-xs hover:text-gray-300 transition-colors flex items-center gap-1"
                                                            title="Copy Answer"
                                                        >
                                                            {copiedIdx === idx
                                                                ? <><CheckCircle2 size={12} className="text-green-400" /> Copied</>
                                                                : <><Copy size={12} /> Copy</>}
                                                        </button>
                                                        <button
                                                            onClick={() => {
                                                                handleSubmit(undefined, messages[idx - 1]?.content || "");
                                                            }}
                                                            className="text-xs hover:text-gray-300 transition-colors flex items-center gap-1"
                                                            title="Retry Response"
                                                        >
                                                            <RotateCcw size={12} />
                                                            Retry
                                                        </button>
                                                    </div>

                                                    {/* Thumbs up/down feedback — persisted to the backend */}
                                                    {msg.id && (
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] uppercase tracking-wider text-gray-600 font-sans">
                                                                {feedbackGiven[msg.id] ? "Thanks for the feedback" : "Was this helpful?"}
                                                            </span>
                                                            <button
                                                                onClick={() => submitFeedback(msg.id, "helpful")}
                                                                className={cn(
                                                                    "transition-colors p-1 hover:bg-white/5 rounded",
                                                                    feedbackGiven[msg.id] === "helpful" ? "text-green-400" : "hover:text-green-400"
                                                                )}
                                                                title="Helpful"
                                                            >
                                                                <ThumbsUp size={13} />
                                                            </button>
                                                            <button
                                                                onClick={() => submitFeedback(msg.id, "not_helpful")}
                                                                className={cn(
                                                                    "transition-colors p-1 hover:bg-white/5 rounded",
                                                                    feedbackGiven[msg.id] === "not_helpful" ? "text-red-400" : "hover:text-red-400"
                                                                )}
                                                                title="Not Helpful"
                                                            >
                                                                <ThumbsDown size={13} />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Contextual follow-ups, generated from this answer's own sources */}
                                                {idx === messages.length - 1 && !isLoading && (
                                                    <div className="mt-4 flex flex-wrap gap-2 items-center animate-in fade-in slide-in-from-bottom-2 duration-300">
                                                        {msg.id && followUpsLoading === msg.id && (
                                                            <span className="text-xs text-gray-600 flex items-center gap-1.5">
                                                                <Loader2 size={11} className="animate-spin" />
                                                                Suggesting follow-ups...
                                                            </span>
                                                        )}

                                                        {msg.id && (followUps[msg.id]?.length ?? 0) > 0 && (
                                                            <>
                                                                <span className="text-xs text-gray-500 self-center">Follow-ups:</span>
                                                                {followUps[msg.id].map((q, i) => (
                                                                    <button
                                                                        key={i}
                                                                        onClick={() => handleSubmit(undefined, q)}
                                                                        className="text-xs bg-white/5 border border-white/10 rounded-full px-3 py-1 text-gray-300 hover:bg-white/10 hover:border-white/20 transition-all font-medium"
                                                                    >
                                                                        {q}
                                                                    </button>
                                                                ))}
                                                            </>
                                                        )}

                                                        <button
                                                            onClick={() => setIsTicketModalOpen(true)}
                                                            className="text-xs bg-purple-500/10 border border-purple-500/20 text-purple-300 rounded-full px-3 py-1 hover:bg-purple-500/20 transition-all flex items-center gap-1 font-medium"
                                                        >
                                                            <Ticket size={11} />
                                                            Escalate to Ticket
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {isLoading && (
                                <div className="flex w-full mt-6 justify-start">
                                    <div className="flex gap-4 w-full">
                                        <div className="w-8 h-8 md:w-9 md:h-9 bg-white rounded-full flex items-center justify-center text-[#212121] flex-shrink-0 mt-1 shadow-sm border border-white/10">
                                            <Bot size={18} />
                                        </div>
                                        <div className="flex flex-col gap-3 w-full max-w-2xl mt-1.5">
                            <div className="flex items-center gap-3">
                                                <span className="text-gray-300 font-medium text-[15px] animate-pulse">Searching sources</span>
                                                <div className="flex -space-x-2">
                                                    <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center animate-bounce shadow-sm z-30" style={{ animationDelay: '0ms' }}><Globe size={11} className="text-blue-400" /></div>
                                                    <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center animate-bounce shadow-sm z-20" style={{ animationDelay: '150ms' }}><BookOpen size={11} className="text-emerald-400" /></div>
                                                    <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center animate-bounce shadow-sm z-10" style={{ animationDelay: '300ms' }}><HelpCircle size={11} className="text-purple-400" /></div>
                                                </div>
                                            </div>
                                            <div className="space-y-2.5 mt-2">
                                                <div className="h-4 bg-white/5 rounded-md w-full animate-pulse"></div>
                                                <div className="h-4 bg-white/5 rounded-md w-5/6 animate-pulse"></div>
                                                <div className="h-4 bg-white/5 rounded-md w-4/6 animate-pulse"></div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} className="h-4" />
                        </div>
                    </div>
                )}

                {/* Input Area */}
                <div className={cn(
                    "w-full px-4 md:px-0 flex flex-col items-center z-20 shrink-0 transition-all duration-500",
                    messages.length === 0 ? "flex-1 justify-center mt-[-8vh]" : "bg-[#212121] pt-4 pb-6 justify-end"
                )}>
                    <div className="w-full max-w-3xl relative flex flex-col items-center">
                        {messages.length === 0 && (
                            <h2 className="text-3xl md:text-4xl font-medium text-white mb-8 tracking-tight text-center">
                                How can I help you today?
                            </h2>
                        )}

                        <style>{`
                            @keyframes spin-slow {
                                from { transform: translate(-50%, -50%) rotate(0deg); }
                                to { transform: translate(-50%, -50%) rotate(360deg); }
                            }
                        `}</style>
                        <div className="relative w-full rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.3)] group overflow-hidden">
                            <div
                                className={cn(
                                    "absolute top-1/2 left-1/2 w-[200%] h-[200%] bg-[conic-gradient(from_0deg,transparent_40%,rgba(255,255,255,1)_100%)] rounded-full z-0 pointer-events-none transition-opacity duration-500",
                                    isLoading ? "opacity-100" : "opacity-0"
                                )}
                                style={{ animation: 'spin-slow 3s linear infinite' }}
                            />

                            <div className="relative flex flex-col w-[calc(100%-4px)] bg-[#2a2a2a] group-focus-within:bg-[#2f2f2f] rounded-[14px] m-[1px] transition-colors duration-300 z-10">
                                <textarea
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSubmit();
                                        }
                                    }}
                                    placeholder={currentPlaceholder + (isDeleting ? "" : "|")}
                                    className="w-full bg-transparent text-white placeholder-gray-400 resize-none focus:outline-none min-h-[56px] py-4 px-5 text-[15px] custom-scrollbar"
                                    style={{ height: 'auto', minHeight: '56px' }}
                                    rows={1}
                                />
                                <div className="flex items-center justify-between px-3 pb-3">
                                    <div className="flex items-center gap-2">
                                        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-gray-200 transition-colors text-xs font-medium">
                                            <Bot size={14} />
                                            Model
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => handleSubmit()}
                                        disabled={!input.trim() || isLoading}
                                        className={cn(
                                            "p-2 rounded-full transition-all flex items-center justify-center w-8 h-8 outline-none",
                                            input.trim() && !isLoading ? "bg-white text-black shadow-md hover:scale-105" : "bg-white/5 text-gray-500 cursor-not-allowed"
                                        )}
                                    >
                                        {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} className="ml-0.5" />}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {messages.length === 0 && (
                            <div className="flex flex-wrap items-center justify-center gap-2.5 mt-6 w-full px-2">
                                {SUGGESTED_QUERIES.map((query, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => handleSubmit(undefined, query.text)}
                                        className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#1c1c1c] border border-white/5 hover:bg-[#2a2a2a] hover:border-white/20 text-gray-300 hover:text-white transition-all text-[13px] font-medium shadow-sm hover:shadow-md"
                                    >
                                        <query.icon size={15} className="text-gray-400" />
                                        {query.label}
                                    </button>
                                ))}
                            </div>
                        )}

                        {messages.length > 0 && (
                            <div className="text-center mt-3 text-xs text-gray-500 font-medium tracking-wide">
                                Valar can make mistakes. Consider checking important information.
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Escalation Ticket Modal */}
            {isTicketModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-[#1e1e1e] border border-white/10 w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-indigo-500"></div>
                        
                        <div className="p-6 font-sans">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                                    <Ticket className="text-purple-400" size={20} />
                                    Raise Support Ticket
                                </h3>
                                <button 
                                    onClick={() => setIsTicketModalOpen(false)}
                                    className="p-1 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-all"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                            
                            {ticketSuccess ? (
                                <div className="py-8 flex flex-col items-center justify-center text-center animate-in zoom-in-95 duration-200">
                                    <CheckCircle2 size={48} className="text-green-400 mb-3 animate-bounce" />
                                    <h4 className="text-white font-medium text-base">Ticket Submitted Successfully!</h4>
                                    <p className="text-gray-400 text-xs mt-1">Our support administrators have been notified.</p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-medium text-gray-400 mb-1">Subject</label>
                                        <input
                                            type="text"
                                            value={ticketSubject}
                                            onChange={(e) => setTicketSubject(e.target.value)}
                                            placeholder="Briefly describe the support request..."
                                            className="w-full p-3 bg-[#2a2a2a] border border-white/10 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-purple-500 transition-all font-sans"
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="block text-xs font-medium text-gray-400 mb-1">Priority Level</label>
                                        <select
                                            value={ticketPriority}
                                            onChange={(e) => setTicketPriority(e.target.value)}
                                            className="w-full p-3 bg-[#2a2a2a] border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-purple-500 transition-all font-sans font-medium"
                                        >
                                            <option value="Low">Low Priority</option>
                                            <option value="Medium">Medium Priority</option>
                                            <option value="High">High Priority</option>
                                            <option value="Urgent">Urgent Priority</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-medium text-gray-400 mb-1">Detailed Description</label>
                                        <textarea
                                            value={ticketDescription}
                                            onChange={(e) => setTicketDescription(e.target.value)}
                                            placeholder="Provide system errors, steps to reproduce, or details to assist support staff..."
                                            className="w-full p-3 bg-[#2a2a2a] border border-white/10 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-purple-500 transition-all font-sans min-h-[100px] resize-none"
                                            rows={4}
                                        />
                                    </div>
                                    
                                    <div className="pt-2 flex justify-end gap-3">
                                        <button
                                            onClick={() => setIsTicketModalOpen(false)}
                                            className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-medium text-gray-300 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (!ticketSubject.trim() || !ticketDescription.trim()) {
                                                    alert("Please fill in all fields.");
                                                    return;
                                                }
                                                const existing = localStorage.getItem("support_tickets");
                                                const tickets = existing ? JSON.parse(existing) : [];
                                                const newT = {
                                                    id: `TKT-${Math.floor(1000 + Math.random() * 9000)}`,
                                                    subject: ticketSubject,
                                                    description: ticketDescription,
                                                    priority: ticketPriority,
                                                    status: "Open",
                                                    createdAt: new Date().toISOString(),
                                                    user: localStorage.getItem("username") || "Agent"
                                                };
                                                tickets.push(newT);
                                                localStorage.setItem("support_tickets", JSON.stringify(tickets));
                                                
                                                setTicketSuccess(true);
                                                setTimeout(() => {
                                                    setTicketSuccess(false);
                                                    setIsTicketModalOpen(false);
                                                    setTicketSubject("");
                                                    setTicketDescription("");
                                                }, 2000);
                                            }}
                                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-medium transition-colors font-semibold"
                                        >
                                            Submit Ticket
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Deletion Confirmation Modal */}
            {sessionToDelete !== null && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-[#1e1e1e] border border-white/10 w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl relative font-sans">
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <Trash2 size={20} />
                            </div>
                            <h3 className="text-base font-semibold text-white mb-2">Delete Conversation?</h3>
                            <p className="text-xs text-gray-400 mb-6 leading-relaxed">
                                Are you sure you want to delete this conversation? This action cannot be undone and will permanently remove all messages.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <button
                                    onClick={() => setSessionToDelete(null)}
                                    className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-medium text-gray-300 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        const id = sessionToDelete;
                                        setSessionToDelete(null);
                                        await confirmDeleteSession(id);
                                    }}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-medium font-semibold transition-colors"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
