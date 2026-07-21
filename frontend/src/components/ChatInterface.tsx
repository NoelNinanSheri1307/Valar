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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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

type ParsedSource = {
    title: string;
    uri: string;
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

const FOLLOW_UP_STOP_WORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which",
    "how", "can", "does", "do", "is", "are", "was", "were", "to", "of", "in", "on", "a",
    "an", "by", "at", "or", "as", "it", "be", "about", "please", "show", "tell", "give",
]);

const stripExtension = (value: string) => value.replace(/\.[^/.]+$/, "");

const normalizeLabel = (value: string) =>
    stripExtension(value)
        .replace(/[\-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const extractKeywords = (value: string, limit = 3) => {
    const words = value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 3 && !FOLLOW_UP_STOP_WORDS.has(word));

    return Array.from(new Set(words)).slice(0, limit);
};

const extractDocumentSections = (content: string) => {
    const sourcesMatch = content.match(/\*\*Sources:\*\*\s*\n([\s\S]+)/);
    const relatedMatch = content.match(/\*\*Related Documents:\*\*\s*\n([\s\S]+)/);

    return {
        sources: parseMarkdownList(sourcesMatch?.[1] || ""),
        relatedDocuments: parsePlainList(relatedMatch?.[1] || ""),
    };
};

const parseMarkdownList = (block: string): ParsedSource[] => {
    const sources: ParsedSource[] = [];
    const sourceRegex = /-\s+\[(.*?)\]\((.*?)\)/g;
    let match;

    while ((match = sourceRegex.exec(block)) !== null) {
        sources.push({ title: match[1], uri: match[2] });
    }

    return sources;
};

const parsePlainList = (block: string) => {
    return block
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
};

const buildFollowUpSuggestions = (answer: string, userQuestion: string, documentNames: string[]) => {
    const suggestions: string[] = [];
    const primaryDocument = normalizeLabel(documentNames[0] || "");
    const secondaryDocument = normalizeLabel(documentNames[1] || "");
    const questionKeywords = extractKeywords(userQuestion, 2);
    const answerKeywords = extractKeywords(answer, 3);
    const topic = questionKeywords[0] || answerKeywords[0] || "this document";

    if (primaryDocument) {
        suggestions.push(`Summarize the key points from ${primaryDocument}.`);
        suggestions.push(`What actions, requirements, or deadlines are mentioned in ${primaryDocument}?`);
    }

    if (primaryDocument && secondaryDocument) {
        suggestions.push(`Compare the guidance in ${primaryDocument} and ${secondaryDocument}.`);
    } else if (primaryDocument) {
        suggestions.push(`Which part of ${primaryDocument} is most relevant to ${topic}?`);
    }

    if (!suggestions.length) {
        suggestions.push(`What does the uploaded document say about ${topic}?`);
    }

    return Array.from(new Set(suggestions)).slice(0, 3);
};

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
    const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);
    const [username, setUsername] = useState("");

    const showToast = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
        setToast({ message, type });
    };

    useEffect(() => {
        const stored = localStorage.getItem("username");
        if (stored) {
            setUsername(stored);
            return;
        }

        const token = localStorage.getItem('token');
        if (!token) {
            return;
        }

        const fetchProfile = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/users/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data.username) {
                        localStorage.setItem('username', data.username);
                        setUsername(data.username);
                    }
                }
            } catch {
                // Keep the fallback empty state if the profile call fails.
            }
        };

        fetchProfile();
    }, []);

    const profileInitial = (username.trim().charAt(0) || 'U').toUpperCase();
    const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const extractedSections = latestAssistantMessage ? extractDocumentSections(latestAssistantMessage.content) : { sources: [], relatedDocuments: [] };
    const followUpSuggestions = latestAssistantMessage
        ? buildFollowUpSuggestions(
            latestAssistantMessage.content,
            latestUserMessage?.content || "",
            extractedSections.relatedDocuments.length > 0
                ? extractedSections.relatedDocuments
                : extractedSections.sources.map((source) => source.title)
        )
        : [];

    const clearConversation = () => {
        setMessages([]);
        setCurrentSessionId(null);
        setInput("");
        setIsExportMenuOpen(false);
        setSessionToDelete(null);
    };

    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

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
                showToast("Conversation deleted successfully", "success");
            } else {
                throw new Error("Failed to delete session");
            }
        } catch (err) {
            console.error(err);
            showToast("Failed to delete this conversation. Please try again.", "error");
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

    const [theme, setTheme] = useState<'light' | 'dark'>('dark');

    useEffect(() => {
        const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' || 'dark';
        setTheme(savedTheme);
        if (savedTheme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, []);

    const toggleTheme = () => {
        const nextTheme = theme === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
        localStorage.setItem('theme', nextTheme);
        if (nextTheme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    };

    const fetchSessions = async (search?: string) => {
        try {
            let path = '/sessions';
            if (search && search.trim() !== '') {
                path += `?search=${encodeURIComponent(search.trim())}`;
            }
            const data = await apiJson<ChatSession[]>(path);
            setSessions(data);
        } catch (error) {
            console.error("Failed to fetch sessions", error);
        }
    };

    // Debounce conversation search by 300ms
    useEffect(() => {
        const delayDebounce = setTimeout(() => {
            fetchSessions(searchQuery);
        }, 300);
        return () => clearTimeout(delayDebounce);
    }, [searchQuery]);

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

        if (relatedMatch) {
            mainContent = mainContent.replace(relatedMatch[0], '').trim();
            const relatedText = relatedMatch[1];
            relatedText
                .split('\n')
                .map((line) => line.replace(/^[-*]\s*/, '').trim())
                .filter(Boolean)
                .forEach((item) => relatedDocuments.push(item));
        }

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

                <div className="flex-1 text-[15px] leading-relaxed break-words mt-1.5 md:mt-2 text-text-primary space-y-4 w-full">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            ul: (props) => <ul className="list-disc pl-6 space-y-1 mb-4" {...props} />,
                            ol: (props) => <ol className="list-decimal pl-6 space-y-1 mb-4" {...props} />,
                            li: (props) => <li className="pl-1 marker:text-text-secondary/75" {...props} />,
                            h1: (props) => <h1 className="text-2xl font-bold mt-6 mb-3 text-text-primary" {...props} />,
                            h2: (props) => <h2 className="text-xl font-bold mt-5 mb-3 text-text-primary pb-1 border-b border-border-default" {...props} />,
                            h3: (props) => <h3 className="text-lg font-bold mt-4 mb-2 text-text-primary" {...props} />,
                            p: (props) => <p className="mb-4 last:mb-0 leading-relaxed" {...props} />,
                            a: (props) => <a className="text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-350 underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 rounded px-0.5 outline-none" target="_blank" rel="noreferrer" {...props} />,
                            code: ({ className, children, ...props }) => {
                                const match = /language-(\w+)/.exec(className || '')
                                return match ? (
                                    <pre className="block bg-bg-tertiary p-4 rounded-xl text-sm font-mono my-4 overflow-x-auto border border-border-default shadow-sm max-w-full">
                                        <code className={cn("text-text-primary", className)} {...props as any}>
                                            {children}
                                        </code>
                                    </pre>
                                ) : (
                                    <code className="bg-button-secondary border border-border-default rounded-md px-1.5 py-0.5 text-[0.9em] font-mono text-purple-600 dark:text-purple-300" {...props as any}>
                                        {children}
                                    </code>
                                )
                            },
                            strong: (props) => <strong className="font-semibold text-text-primary" {...props} />,
                            blockquote: (props) => <blockquote className="border-l-2 border-purple-500/50 pl-4 py-1 italic text-text-secondary my-4 bg-purple-500/5 rounded-r-lg" {...props} />,
                            table: (props) => <div className="w-full overflow-x-auto my-4 max-w-full"><table className="w-full text-sm text-left border-collapse border border-border-default rounded-xl overflow-hidden" {...props} /></div>,
                            th: (props) => <th className="bg-bg-tertiary p-3 border-b border-border-default font-semibold text-text-primary" {...props} />,
                            td: (props) => <td className="p-3 border-b border-border-default last:border-0" {...props} />,
                        }}
                    >
                        {mainContent.replace(/\[\d+\]/g, '')}
                    </ReactMarkdown>
                </div>

                {citations.length > 0 && (
                    <div className="w-full mt-5 border-t border-border-default pt-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-semibold text-text-secondary flex items-center gap-1.5 uppercase tracking-wider">
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
                                            <div className="w-4 h-4 rounded-full bg-button-secondary flex items-center justify-center text-[9px] text-text-primary font-semibold shrink-0 group-hover:bg-bg-tertiary transition-colors">
                                                {c.index}
                                            </div>
                                            <span className="text-[13px] font-medium text-text-primary truncate flex-1">
                                                {label}
                                            </span>
                                            {c.score > 0 && (
                                                <span className="text-[10px] text-text-secondary tabular-nums shrink-0">
                                                    {Math.round(c.score * 100)}%
                                                </span>
                                            )}
                                        </div>
                                        {c.snippet && (
                                            <p className="text-[11px] text-text-secondary mt-1.5 line-clamp-2 leading-relaxed">
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
                                        className="group flex flex-col bg-bg-tertiary hover:bg-bg-primary border border-border-default hover:border-text-secondary rounded-xl px-3 py-2.5 transition-all text-left w-full shadow-sm overflow-hidden"
                                    >
                                        {inner}
                                    </a>
                                ) : (
                                    <div
                                        key={c.index}
                                        title={c.snippet}
                                        className="group flex flex-col bg-bg-tertiary border border-border-default rounded-xl px-3 py-2.5 text-left w-full shadow-sm overflow-hidden"
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
                    <div className="mt-4 text-[11px] text-text-secondary flex items-center gap-1.5">
                        <AlertTriangle size={12} className="text-text-secondary" />
                        No supporting document was found for this answer.
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full w-full bg-bg-primary text-text-primary font-sans overflow-hidden">
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
                    "fixed inset-y-0 left-0 z-40 w-[300px] bg-bg-secondary transform transition-all duration-300 ease-in-out md:relative md:translate-x-0 flex flex-col border-r border-border-default",
                    !sidebarOpen && "-translate-x-full md:w-0 md:opacity-0 md:border-none overflow-hidden"
                )}
            >
                <div className="flex flex-col h-full p-3 w-[300px]">
                    <div className="flex items-center justify-between mb-4 md:hidden text-text-secondary px-1 pt-1">
                        <span className="font-semibold text-text-primary">Menu</span>
                        <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-button-secondary rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none" title="Close Sidebar">
                            <X size={20} />
                        </button>
                    </div>

                    <button
                        onClick={() => {
                            setMessages([]);
                            setCurrentSessionId(null);
                            if (window.innerWidth < 768) setSidebarOpen(false);
                        }}
                        className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-bg-tertiary transition-all text-sm text-text-primary border border-border-default shadow-sm mb-4 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none font-medium cursor-pointer"
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
                            className="w-full text-xs p-2.5 bg-input-background border border-border-default rounded-xl focus:outline-none text-text-primary focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all font-sans placeholder-text-secondary/60 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none"
                        />
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
                        <div className="text-xs font-semibold text-text-secondary opacity-75 px-3 py-2 mb-1">Recent Chats</div>
                        {sessions.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-text-secondary italic">No previous chats</div>
                        ) : (
                            sessions
                                .map((session) => (
                                    <div
                                        key={session.id}
                                        onClick={() => loadSession(session.id)}
                                        className={cn(
                                            "group px-3 py-2.5 text-sm truncate rounded-xl cursor-pointer transition-all mb-1 flex items-center gap-3 border focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none",
                                            currentSessionId === session.id
                                                ? "bg-purple-500/10 text-purple-600 dark:text-purple-300 font-semibold border-purple-500/20 shadow-sm"
                                                : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary border-transparent"
                                        )}
                                    >
                                        <MessageSquare size={14} className={currentSessionId === session.id ? "text-purple-500" : "text-text-secondary"} />
                                        <span className="truncate flex-1">{session.title}</span>
                                        
                                        <button 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSessionToDelete(session.id);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-button-secondary rounded-lg text-text-secondary hover:text-red-500 transition-all shrink-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none"
                                            title="Delete Session"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))
                        )}
                    </div>

                    {/* Support Status & Help Indicators */}
                    <div className="border-t border-border-default pt-3 mt-2 space-y-2">
                        <div className="px-3 py-2 flex items-center justify-between text-[11px] text-text-secondary bg-bg-tertiary rounded-xl border border-border-default">
                            <span className="flex items-center gap-1.5 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                Support System
                            </span>
                            <span className="text-text-secondary font-semibold uppercase text-[9px] tracking-wider bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">Ready</span>
                        </div>

                        <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-bg-tertiary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none">
                            <div className="w-8 h-8 rounded-full bg-text-primary text-bg-primary border border-border-default flex items-center justify-center font-bold text-sm shadow-md uppercase">
                                {profileInitial}
                            </div>
                            <div className="text-sm font-medium text-text-primary truncate max-w-[150px]">
                                {username || 'Signed in user'}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col h-full relative w-full overflow-x-hidden">
                {/* Header */}
                <div className="sticky top-0 z-30 flex items-center justify-between p-3 text-text-primary bg-bg-primary/95 backdrop-blur-md border-b border-border-default w-full">
                    <div className="flex items-center">
                        <button
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            className="p-2 hover:bg-bg-tertiary rounded-xl text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                            title="Toggle Sidebar"
                        >
                            <Menu size={20} />
                        </button>
                        <span className="ml-3 font-semibold text-base text-text-primary flex items-center gap-2">
                            <Bot size={18} className="text-purple-400 font-bold" />
                             Valar — Document Support Chatbot
                        </span>
                    </div>

                    {/* Quick Support Actions */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={toggleTheme}
                            className="p-1.5 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center animate-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                            title={theme === 'dark' ? "Switch to Light Theme" : "Switch to Dark Theme"}
                        >
                            {theme === 'dark' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-400"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                            )}
                        </button>

                        <button
                            onClick={() => router.push('/ops_admin')}
                            className="bg-button-secondary text-text-primary px-3 py-1.5 rounded-xl text-xs font-medium hover:bg-bg-tertiary transition-all border border-border-default focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                        >
                            Support Dashboard
                        </button>

                        {messages.length > 0 && (
                            <div className="relative">
                                <button
                                    onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
                                    className="p-1.5 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-text-secondary hover:text-text-primary text-xs font-medium transition-all flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                                    title="Export Session"
                                >
                                    <Download size={14} />
                                    Export
                                </button>
                                
                                {isExportMenuOpen && (
                                    <div className="absolute right-0 top-10 w-44 bg-card-background border border-border-default rounded-xl shadow-md py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                                        <button 
                                            onClick={() => { exportAsMarkdown(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            Markdown (.md)
                                        </button>
                                        <button 
                                            onClick={() => { exportAsPDF(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            PDF Document (.pdf)
                                        </button>
                                        <button 
                                            onClick={() => { exportAsPlainText(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            Plain Text (.txt)
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {messages.length > 0 && (
                            <button
                                onClick={clearConversation}
                                className="bg-button-secondary hover:bg-bg-tertiary text-text-primary px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border border-border-default focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                                title="Clear current conversation"
                            >
                                <Trash2 size={14} />
                                Clear Chat
                            </button>
                        )}
                        
                        <button
                            onClick={() => setIsTicketModalOpen(true)}
                            className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 shadow-sm hover:shadow-md focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                            title="Raise Support Ticket"
                        >
                            <Ticket size={14} />
                            File Ticket
                        </button>

                        {handleLogout && (
                            <button
                                onClick={handleLogout}
                                className="bg-red-500/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-xl text-xs font-medium hover:bg-red-500 hover:text-white transition-all focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer"
                            >
                                Logout
                            </button>
                        )}
                    </div>
                </div>                {/* Messages Area */}
                {messages.length > 0 && (
                    <div className="flex-1 overflow-y-auto custom-scrollbar w-full flex flex-col items-center">
                        <div className="flex flex-col w-full max-w-4xl pb-4 pt-4 px-4 md:px-0">
                            {messages.map((msg, idx) => (
                                <div key={idx} className={cn("flex w-full mt-6 first:mt-0", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                    {msg.role === 'user' ? (
                                        <div className="max-w-[85%] md:max-w-[75%] bg-purple-500/10 text-text-primary border border-purple-500/20 rounded-2xl rounded-tr-none px-5 py-3.5 shadow-sm text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                                            {msg.content}
                                        </div>
                                    ) : (
                                        <div className="flex gap-3 w-full max-w-[90%] md:max-w-[80%]">
                                            <div className="w-8 h-8 md:w-9 md:h-9 bg-card-background rounded-full flex items-center justify-center text-text-primary flex-shrink-0 mt-1 shadow-sm border border-border-default">
                                                <Bot size={18} />
                                            </div>
                                            <div className="flex-1 flex flex-col min-w-0 bg-card-background border border-border-default rounded-2xl rounded-tl-none p-5 shadow-sm">
                                                {renderMessageContent(msg)}

                                                {/* Assistant Message Actions & Feedback */}
                                                <div className="flex flex-wrap items-center justify-between mt-4 text-text-secondary opacity-80 border-t border-border-default pt-3 gap-2">
                                                    <div className="flex items-center gap-4">
                                                        <button
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(msg.content);
                                                                setCopiedIdx(idx);
                                                                setTimeout(() => setCopiedIdx(null), 2000);
                                                            }}
                                                            className="text-xs hover:text-text-primary transition-colors flex items-center gap-1.5 font-medium focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none rounded p-0.5 cursor-pointer"
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
                                                            className="text-xs hover:text-text-primary transition-colors flex items-center gap-1.5 font-medium focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none rounded p-0.5 cursor-pointer"
                                                            title="Retry Response"
                                                        >
                                                            <RotateCcw size={12} />
                                                            Retry
                                                        </button>
                                                    </div>

                                                    {/* Thumbs up/down feedback — persisted to the backend */}
                                                    {msg.id && (
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] uppercase tracking-wider text-text-secondary opacity-60 font-sans">
                                                                {feedbackGiven[msg.id] ? "Thanks for the feedback" : "Was this helpful?"}
                                                            </span>
                                                            <button
                                                                onClick={() => submitFeedback(msg.id, "helpful")}
                                                                className={cn(
                                                                    "transition-colors p-1 hover:bg-button-secondary rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none",
                                                                    feedbackGiven[msg.id] === "helpful" ? "text-green-400" : "hover:text-green-400"
                                                                )}
                                                                title="Helpful"
                                                            >
                                                                <ThumbsUp size={13} />
                                                            </button>
                                                            <button
                                                                onClick={() => submitFeedback(msg.id, "not_helpful")}
                                                                className={cn(
                                                                    "transition-colors p-1 hover:bg-button-secondary rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none",
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
                                                    <div className="mt-4 flex flex-wrap gap-2 items-center animate-in fade-in slide-in-from-bottom-2 duration-300 border-t border-border-default pt-3">
                                                        {msg.id && followUpsLoading === msg.id && (
                                                            <span className="text-xs text-text-secondary flex items-center gap-1.5">
                                                                <Loader2 size={11} className="animate-spin" />
                                                                Suggesting follow-ups...
                                                            </span>
                                                        )}

                                                        {msg.id && (followUps[msg.id]?.length ?? 0) > 0 && (
                                                            <>
                                                                <span className="text-xs text-text-secondary opacity-80 self-center font-medium">Follow-ups:</span>
                                                                {followUps[msg.id].map((q, i) => (
                                                                    <button
                                                                        key={i}
                                                                        onClick={() => handleSubmit(undefined, q)}
                                                                        className="text-xs bg-button-secondary border border-border-default rounded-xl px-3 py-1.5 text-text-primary hover:bg-bg-tertiary transition-all font-medium focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                                                                    >
                                                                        {q}
                                                                    </button>
                                                                ))}
                                                            </>
                                                        )}

                                                        <button 
                                                            onClick={() => setIsTicketModalOpen(true)}
                                                            className="text-xs bg-purple-500/10 border border-purple-500/20 text-purple-600 dark:text-purple-300 rounded-xl px-3 py-1.5 hover:bg-purple-500/20 transition-all flex items-center gap-1.5 font-medium focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
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
                                    <div className="flex gap-3 w-full max-w-[90%] md:max-w-[80%]">
                                        <div className="w-8 h-8 md:w-9 md:h-9 bg-card-background rounded-full flex items-center justify-center text-text-primary flex-shrink-0 mt-1 shadow-sm border border-border-default">
                                            <Bot size={18} />
                                        </div>
                                        <div className="flex-1 flex flex-col min-w-0 bg-card-background border border-border-default rounded-2xl rounded-tl-none p-5 shadow-sm">
                                            <div className="flex items-center gap-3">
                                                <span className="text-text-secondary font-medium text-[15px] animate-pulse">Searching sources</span>
                                                <div className="flex -space-x-1.5">
                                                    <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center animate-bounce shadow-sm z-30" style={{ animationDelay: '0ms' }}><Globe size={11} className="text-blue-400" /></div>
                                                    <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center animate-bounce shadow-sm z-20" style={{ animationDelay: '150ms' }}><BookOpen size={11} className="text-emerald-400" /></div>
                                                    <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center animate-bounce shadow-sm z-10" style={{ animationDelay: '300ms' }}><HelpCircle size={11} className="text-purple-400" /></div>
                                                </div>
                                            </div>
                                            <div className="space-y-2.5 mt-4">
                                                <div className="h-3.5 bg-bg-tertiary rounded-md w-full animate-pulse"></div>
                                                <div className="h-3.5 bg-bg-tertiary rounded-md w-5/6 animate-pulse"></div>
                                                <div className="h-3.5 bg-bg-tertiary rounded-md w-4/6 animate-pulse"></div>
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
                    messages.length === 0 ? "flex-1 justify-center mt-[-8vh]" : "bg-bg-primary pt-4 pb-6 justify-end"
                )}>
                    <div className="w-full max-w-5xl relative flex flex-col items-center animate-none">
                        {messages.length === 0 && (
                            <div className="flex flex-col items-center gap-5 mb-8">
                                <div className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 border border-purple-500/20 rounded-full animate-in fade-in slide-in-from-top-3 duration-500">
                                    <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-300 tracking-wide uppercase">How it works</span>
                                    <span className="text-[11px] text-text-secondary">Upload docs in Dashboard</span>
                                    <span className="text-text-secondary opacity-60">&#8594;</span>
                                    <span className="text-[11px] text-text-secondary">Ask Valar anything</span>
                                    <span className="text-text-secondary opacity-60">&#8594;</span>
                                    <span className="text-[11px] text-text-secondary">Get instant answers</span>
                                </div>
                                <h2 className="text-3xl md:text-4xl font-medium text-text-primary tracking-tight text-center">
                                    How can I help you today?
                                </h2>
                            </div>
                        )}

                        <style>{`
                            @keyframes spin-slow {
                                from { transform: translate(-50%, -50%) rotate(0deg); }
                                to { transform: translate(-50%, -50%) rotate(360deg); }
                            }
                        `}</style>
                        <div className="relative w-full rounded-xl shadow-md group overflow-hidden border border-border-default">
                            <div
                                className={cn(
                                    "absolute top-1/2 left-1/2 w-[200%] h-[200%] bg-[conic-gradient(from_0deg,transparent_40%,var(--text-primary)_100%)] rounded-full z-0 pointer-events-none transition-opacity duration-500",
                                    isLoading ? "opacity-100" : "opacity-0"
                                )}
                                style={{ animation: 'spin-slow 3s linear infinite' }}
                            />

                            <div className="relative flex flex-col w-[calc(100%-2px)] bg-input-background focus-within:bg-bg-tertiary rounded-xl m-[1px] transition-all duration-300 z-10 focus-within:ring-2 focus-within:ring-purple-500 focus-within:outline-none">
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
                                    className="w-full bg-transparent text-text-primary placeholder-text-secondary/60 resize-none focus:outline-none min-h-[56px] py-4 px-5 text-[15px] custom-scrollbar font-sans outline-none font-medium"
                                    style={{ height: 'auto', minHeight: '56px' }}
                                    rows={1}
                                />
                                <div className="flex items-center justify-between px-3 pb-3">
                                    <div className="flex items-center gap-2">
                                        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-button-secondary hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors text-xs font-medium focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer border border-border-default">
                                            <Bot size={14} />
                                            Model
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => handleSubmit()}
                                        disabled={!input.trim() || isLoading}
                                        className={cn(
                                            "p-2 rounded-xl transition-all flex items-center justify-center w-8 h-8 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer",
                                            input.trim() && !isLoading ? "bg-text-primary text-bg-primary shadow-sm hover:scale-105" : "bg-button-secondary text-text-secondary/50 cursor-not-allowed border border-border-default"
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
                                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-default hover:bg-bg-primary hover:border-text-secondary text-text-secondary hover:text-text-primary transition-all text-[13px] font-medium shadow-sm hover:shadow-md focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                                    >
                                        <query.icon size={15} className="text-text-secondary" />
                                        {query.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Escalation Ticket Modal */}
            {isTicketModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-card-background border border-border-default w-full max-w-lg rounded-2xl overflow-hidden shadow-md relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-indigo-500"></div>
                        
                        <div className="p-6 font-sans">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                                    <Ticket className="text-purple-400" size={20} />
                                    Raise Support Ticket
                                </h3>
                                <button 
                                    onClick={() => setIsTicketModalOpen(false)}
                                    className="p-1 hover:bg-bg-tertiary rounded-xl text-text-secondary hover:text-text-primary transition-all focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                            
                            {ticketSuccess ? (
                                <div className="py-8 flex flex-col items-center justify-center text-center animate-in zoom-in-95 duration-200">
                                    <CheckCircle2 size={48} className="text-green-400 mb-3 animate-bounce" />
                                    <h4 className="text-text-primary font-medium text-base">Ticket Submitted Successfully!</h4>
                                    <p className="text-text-secondary text-xs mt-1">Our support administrators have been notified.</p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Subject</label>
                                        <input
                                            type="text"
                                            value={ticketSubject}
                                            onChange={(e) => setTicketSubject(e.target.value)}
                                            placeholder="Briefly describe the support request..."
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none transition-all font-sans font-medium"
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Priority Level</label>
                                        <select
                                            value={ticketPriority}
                                            onChange={(e) => setTicketPriority(e.target.value)}
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none transition-all font-sans font-semibold cursor-pointer"
                                        >
                                            <option value="Low">Low Priority</option>
                                            <option value="Medium">Medium Priority</option>
                                            <option value="High">High Priority</option>
                                            <option value="Urgent">Urgent Priority</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Detailed Description</label>
                                        <textarea
                                            value={ticketDescription}
                                            onChange={(e) => setTicketDescription(e.target.value)}
                                            placeholder="Provide system errors, steps to reproduce, or details to assist support staff..."
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none transition-all font-sans min-h-[100px] resize-none font-medium"
                                            rows={4}
                                        />
                                    </div>
                                    
                                    <div className="pt-2 flex justify-end gap-3">
                                        <button
                                            onClick={() => setIsTicketModalOpen(false)}
                                            className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (!ticketSubject.trim() || !ticketDescription.trim()) {
                                                    showToast("Please fill in all fields.", "error");
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
                                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-medium transition-colors font-semibold focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
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
                    <div className="bg-card-background border border-border-default w-full max-w-sm rounded-2xl overflow-hidden shadow-md relative font-sans">
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <Trash2 size={20} />
                            </div>
                            <h3 className="text-base font-semibold text-text-primary mb-2 font-sans">Delete Conversation?</h3>
                            <p className="text-xs text-text-secondary mb-6 leading-relaxed font-sans">
                                Are you sure you want to delete this conversation? This action cannot be undone and will permanently remove all messages.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <button
                                    onClick={() => setSessionToDelete(null)}
                                    className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        const id = sessionToDelete;
                                        setSessionToDelete(null);
                                        await confirmDeleteSession(id);
                                    }}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-medium font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Toast Notification */}
            {toast && (
                <div className="fixed bottom-6 right-6 z-[100] animate-in slide-in-from-bottom-5 duration-300 pointer-events-auto">
                    <div className={cn(
                        "px-4 py-3 rounded-xl border flex items-center gap-3 shadow-md backdrop-blur-md",
                        toast.type === 'error' ? "bg-red-500/10 border-red-500/20 text-red-200" :
                        toast.type === 'success' ? "bg-green-500/10 border-green-500/20 text-green-200" :
                        "bg-card-background border-border-default text-text-primary"
                    )}>
                        <span className="text-xs font-semibold">{toast.message}</span>
                        <button onClick={() => setToast(null)} className="hover:bg-button-secondary p-1 rounded-lg transition-colors text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:outline-none outline-none cursor-pointer">
                            <X size={12} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
