"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import UploadComponent from "../../components/Upload";
import {
    ArrowLeft, LayoutDashboard, Database, Settings, FileText,
    Clock, Ticket, BarChart2, HelpCircle, Activity, ChevronRight,
    AlertCircle, Trash2, CheckCircle2, RotateCcw, Loader2, X
} from "lucide-react";

type UploadedFile = {
    filename: string;
    size: number;
    uploaded_at: string;
};

type SupportTicket = {
    id: string;
    subject: string;
    description: string;
    priority: "Low" | "Medium" | "High" | "Urgent";
    status: "Open" | "In Progress" | "Resolved";
    createdAt: string;
    user: string;
};

// Simple clsx utility helper
function cn(...classes: string[]) {
    return classes.filter(Boolean).join(" ");
}

export default function AdminPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [files, setFiles] = useState<UploadedFile[]>([]);

    // Tab routing state
    const [activeTab, setActiveTab] = useState<'documents' | 'tickets' | 'faq' | 'analytics'>('documents');

    // Support tickets state
    const [tickets, setTickets] = useState<SupportTicket[]>([]);

    // FAQ and Analytics integrated states
    type FaqRule = { id: number; keyword: string; response: string; is_active: boolean };
    const [faqs, setFaqs] = useState<FaqRule[]>([]);
    const [newKeyword, setNewKeyword] = useState("");
    const [newResponse, setNewResponse] = useState("");
    const [newIsActive, setNewIsActive] = useState(true);
    const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);
    const [faqToDelete, setFaqToDelete] = useState<number | null>(null);
    const [fileToDelete, setFileToDelete] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState({ vectorStore: "Checking Status", sqLite: "Checking Status" });

    const showToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
        setToast({ message, type });
    };

    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

    type GapItem = { query_text: string; failure_count: number; highest_score: number; created_at: string };
    const [analyticsData, setAnalyticsData] = useState<{ failed_rate: string; total_failed: number; gaps: GapItem[] }>({
        failed_rate: "0.0%",
        total_failed: 0,
        gaps: [],
    });

    const [reindexState, setReindexState] = useState<Record<string, string>>({});
    const [deleteState, setDeleteState] = useState<Record<string, string>>({});

    const handleReindex = async (filename: string) => {
        if (reindexState[filename] === "loading") return; // prevent duplicate
        setReindexState(prev => ({ ...prev, [filename]: "loading" }));
        showToast("Re-indexing document... Please wait.", "info");
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`http://localhost:8000/reindex/${encodeURIComponent(filename)}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Re-index failed");
            }
            // Poll until done (max 120s, every 2s)
            let attempts = 0;
            const poll = setInterval(async () => {
                attempts++;
                try {
                    const statusRes = await fetch(
                        `http://localhost:8000/reindex/${encodeURIComponent(filename)}/status`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    const statusData = await statusRes.json();
                    if (statusData.status === "done") {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: "done" }));
                        showToast("Document re-indexed successfully.", "success");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 4000);
                    } else if (statusData.status === "error") {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: `error:${statusData.detail}` }));
                        showToast(`Re-index failed: ${statusData.detail}`, "error");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
                    } else if (attempts >= 60) {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: "error:Timed out" }));
                        showToast("Re-index failed: Timed out.", "error");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
                    }
                } catch { /* network hiccup, keep polling */ }
            }, 2000);
        } catch (err: any) {
            setReindexState(prev => ({ ...prev, [filename]: `error:${err.message}` }));
            showToast(`Re-index failed: ${err.message}`, "error");
            setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
        }
    };

    const confirmDeleteFile = async (filename: string) => {
        if (deleteState[filename] === "loading") return;
        setDeleteState(prev => ({ ...prev, [filename]: "loading" }));
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`http://localhost:8000/files/${encodeURIComponent(filename)}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Delete failed");
            }
            setDeleteState(prev => ({ ...prev, [filename]: "done" }));
            showToast(`Document "${filename}" deleted successfully`, "success");
            fetchFiles(); // refresh list
            setTimeout(() => setDeleteState(prev => ({ ...prev, [filename]: "idle" })), 3000);
        } catch (err: any) {
            setDeleteState(prev => ({ ...prev, [filename]: `error` }));
            showToast(`Failed to delete: ${err.message}`, "error");
            setTimeout(() => setDeleteState(prev => ({ ...prev, [filename]: "idle" })), 4000);
        }
    };

    const fetchFaqs = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('http://localhost:8000/faq', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setFaqs(data);
            }
        } catch (error) {
            console.error("Failed to fetch FAQs", error);
        }
    };

    const handleAddFaq = async () => {
        if (!newKeyword.trim() || !newResponse.trim()) {
            showToast("Please fill in both keyword and response.", "error");
            return;
        }
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('http://localhost:8000/faq', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    keyword: newKeyword.trim(),
                    response: newResponse.trim(),
                    is_active: newIsActive
                })
            });
            if (res.ok) {
                setNewKeyword("");
                setNewResponse("");
                fetchFaqs();
                showToast("FAQ rule added successfully", "success");
            } else {
                const errorData = await res.json();
                showToast(errorData.detail || "Failed to add FAQ rule", "error");
            }
        } catch (error) {
            console.error("Failed to add FAQ", error);
            showToast("Failed to add FAQ rule due to connection error", "error");
        }
    };

    const confirmDeleteFaq = async (id: number) => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`http://localhost:8000/faq/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                fetchFaqs();
                showToast("FAQ rule deleted successfully", "success");
            } else {
                showToast("Failed to delete FAQ rule", "error");
            }
        } catch (error) {
            console.error("Failed to delete FAQ", error);
            showToast("Failed to delete FAQ rule due to connection error", "error");
        }
    };

    const fetchAnalytics = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('http://localhost:8000/analytics/gaps', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setAnalyticsData(data);
            }
        } catch (error) {
            console.error("Failed to fetch analytics gaps", error);
        }
    };
    const fetchFiles = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('http://localhost:8000/files', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setFiles(data.sort((a: any, b: any) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()));
            }
        } catch (error) {
            console.error("Failed to fetch files", error);
        }
    };

    const loadTickets = () => {
        const existing = localStorage.getItem("support_tickets");
        if (existing) {
            setTickets(JSON.parse(existing));
        } else {
            // Seed a mock ticket if empty
            const seedTickets: SupportTicket[] = [
                {
                    id: "TKT-3120",
                    subject: "Refund approval permission setup",
                    description: "Refund request for client transaction TXN-8291 exceeds local agent limit ($500). Customer Support agent needs documentation on senior supervisor authorization procedure.",
                    priority: "High",
                    status: "Open",
                    createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
                    user: "Agent_A"
                },
                {
                    id: "TKT-2490",
                    subject: "Email routing failure for billing domain",
                    description: "Incoming support queries from billing domain are bypassing Zendesk routing queues and going to dead-letter folder. Please review filter configurations.",
                    priority: "Medium",
                    status: "In Progress",
                    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
                    user: "Agent_Support"
                }
            ];
            localStorage.setItem("support_tickets", JSON.stringify(seedTickets));
            setTickets(seedTickets);
        }
    };

    const handleUpdateTicketStatus = (ticketId: string, newStatus: "Open" | "In Progress" | "Resolved") => {
        const updated = tickets.map(t => {
            if (t.id === ticketId) {
                return { ...t, status: newStatus };
            }
            return t;
        });
        setTickets(updated);
        localStorage.setItem("support_tickets", JSON.stringify(updated));
    };

    const handleDeleteTicket = (ticketId: string) => {
        const updated = tickets.filter(t => t.id !== ticketId);
        setTickets(updated);
        localStorage.setItem("support_tickets", JSON.stringify(updated));
    };

    useEffect(() => {
        const token = localStorage.getItem('token');
        const role = localStorage.getItem('role');

        if (!token) {
            router.push('/');
        } else {
            setLoading(false);
            fetchFiles();
            loadTickets();
            fetchFaqs();
            fetchAnalytics();

            // Real-time backend system status check
            const checkHealth = async () => {
                try {
                    const res = await fetch("http://localhost:8000/");
                    if (res.ok) {
                        setSystemStatus({ vectorStore: "Online", sqLite: "Online" });
                    } else {
                        setSystemStatus({ vectorStore: "Offline", sqLite: "Offline" });
                    }
                } catch {
                    setSystemStatus({ vectorStore: "Offline", sqLite: "Offline" });
                }
            };
            checkHealth();
        }
    }, [router]);

    if (loading) return <div className="min-h-[100dvh] bg-[#121212] text-white flex items-center justify-center">Loading Admin...</div>;

    return (
        <main className="h-[100dvh] overflow-y-auto w-full bg-[#121212] flex flex-col items-center custom-scrollbar">
            {/* Navigation Bar */}
            <div className="w-full bg-[#1a1a1a] border-b border-white/5 p-4 flex items-center justify-between sticky top-0 z-50 shadow-md">
                <div className="flex items-center gap-4 px-2 md:px-6">
                    <button
                        onClick={() => router.push('/')}
                        className="p-2 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
                        title="Back to Chat"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <div className="flex items-center gap-2 text-white font-medium text-lg">
                        <LayoutDashboard size={20} className="text-purple-500" />
                        Enterprise Support Dashboard
                    </div>
                </div>
            </div>

            {/* Dashboard Content */}
            <div className="w-full max-w-6xl p-6 md:p-12 flex flex-col gap-8 flex-1">
                <div className="flex flex-col gap-2">
                    <h1 className="text-3xl font-bold text-white tracking-tight">AI Support Console</h1>
                    <p className="text-gray-400 text-sm">Empower your support agents and administrators with document intelligence and tickets tracking.</p>
                </div>

                {/* Tabs Bar */}
                <div className="flex border-b border-white/5 gap-6 text-sm text-gray-400 mt-2">
                    <button
                        onClick={() => setActiveTab('documents')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'documents' ? "text-purple-400 font-semibold" : "hover:text-white")}
                    >
                        <FileText size={15} />
                        Knowledge Documents
                        {activeTab === 'documents' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-purple-500 rounded-full" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('tickets')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'tickets' ? "text-purple-400 font-semibold" : "hover:text-white")}
                    >
                        <Ticket size={15} />
                        Support Tickets
                        {tickets.filter(t => t.status !== "Resolved").length > 0 && (
                            <span className="bg-purple-600 text-white rounded-full text-[10px] w-4.5 h-4.5 flex items-center justify-center font-bold">
                                {tickets.filter(t => t.status !== "Resolved").length}
                            </span>
                        )}
                        {activeTab === 'tickets' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-purple-500 rounded-full" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('faq')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'faq' ? "text-purple-400 font-semibold" : "hover:text-white")}
                    >
                        <HelpCircle size={15} />
                        FAQ Canned Layer
                        {activeTab === 'faq' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-purple-500 rounded-full" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('analytics')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'analytics' ? "text-purple-400 font-semibold" : "hover:text-white")}
                    >
                        <BarChart2 size={15} />
                        Analytics & Gaps
                        {activeTab === 'analytics' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-purple-500 rounded-full" />}
                    </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.85fr)_minmax(340px,0.95fr)] gap-8 flex-1 min-h-0">
                    <div className="lg:col-span-2 flex flex-col gap-6">

                        {/* TAB 1: Documents Management */}
                        {activeTab === 'documents' && (
                            <>
                                <UploadComponent onUploadSuccess={fetchFiles} />

                                <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[300px]">
                                    <h3 className="font-medium text-white flex items-center gap-2 mb-4">
                                        <FileText size={18} className="text-purple-400" />
                                        Indexed Knowledge Base
                                    </h3>
                                    {files.length === 0 ? (
                                        <div className="text-center py-8 text-gray-500 text-sm">No documents found. Upload one to start tracking.</div>
                                    ) : (
                                        <div className="flex flex-col gap-3 overflow-y-auto flex-1 custom-scrollbar pr-2 min-h-0">
                                            {files.map((f, idx) => (
                                                <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                                                    <div className="flex items-center gap-3 overflow-hidden">
                                                        <div className="w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                                                            <FileText size={14} className="text-purple-400" />
                                                        </div>
                                                        <div className="overflow-hidden">
                                                            <p className="text-sm font-medium text-white truncate">{f.filename}</p>
                                                            <p className="text-xs text-gray-500">{(f.size / 1024 / 1024).toFixed(2)} MB</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-4 text-xs text-gray-400 flex-shrink-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <Clock size={12} />
                                                            <span>{new Date(f.uploaded_at).toLocaleDateString()}</span>
                                                        </div>                                                         {/* Re-index button with live state */}
                                                        {(() => {
                                                            const st = reindexState[f.filename] || "idle";
                                                            if (st === "loading") return (
                                                                <span className="flex items-center gap-1.5 text-yellow-400 font-medium cursor-wait">
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                    Indexing...
                                                                </span>
                                                            );
                                                            if (st === "done") return (
                                                                <span className="flex items-center gap-1.5 text-green-400 font-medium">
                                                                    <CheckCircle2 size={12} />
                                                                    Indexed!
                                                                </span>
                                                            );
                                                            if (st.startsWith("error:")) return (
                                                                <span className="flex items-center gap-1.5 text-red-400 font-medium max-w-[140px] truncate" title={st.slice(6)}>
                                                                    Failed
                                                                </span>
                                                            );
                                                            return (
                                                                <button
                                                                    onClick={() => handleReindex(f.filename)}
                                                                    className="flex items-center gap-1.5 text-purple-400 hover:text-purple-300 font-medium transition-colors"
                                                                    title="Re-index this document"
                                                                >
                                                                    <RotateCcw size={12} />
                                                                    Re-index
                                                                </button>
                                                            );
                                                        })()}

                                                        {/* Delete button with live state */}
                                                        {deleteState[f.filename] === "loading" ? (
                                                            <span className="flex items-center gap-1 text-gray-400 cursor-wait">
                                                                <Loader2 size={12} className="animate-spin" />
                                                            </span>
                                                        ) : (
                                                            <button
                                                                onClick={() => setFileToDelete(f.filename)}
                                                                className="p-1 hover:bg-red-500/10 text-gray-500 hover:text-red-400 rounded transition-colors"
                                                                title="Delete document"
                                                            >
                                                                <Trash2 size={13} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}

                        {/* TAB 2: Support Tickets (Interactive Table) */}
                        {activeTab === 'tickets' && (
                            <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <h3 className="font-medium text-white flex items-center gap-2 mb-4">
                                    <Ticket size={18} className="text-purple-400" />
                                    Active Support Tickets ({tickets.length})
                                </h3>

                                {tickets.length === 0 ? (
                                    <div className="text-center py-12 text-gray-500 text-sm">No support tickets filed yet.</div>
                                ) : (
                                    <div className="flex flex-col gap-4 overflow-y-auto flex-1 custom-scrollbar pr-2 min-h-0">
                                        {tickets.map((t) => (
                                            <div key={t.id} className="p-4 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all flex flex-col gap-3 relative">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-mono bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded font-semibold">{t.id}</span>
                                                        <h4 className="text-sm font-semibold text-white truncate max-w-xs">{t.subject}</h4>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className={cn(
                                                            "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                                                            t.priority === "Urgent" ? "bg-red-500/10 text-red-500 border border-red-500/20" :
                                                                t.priority === "High" ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" :
                                                                    t.priority === "Medium" ? "bg-blue-500/10 text-blue-500 border border-blue-500/20" :
                                                                        "bg-gray-500/10 text-gray-400 border border-gray-500/20"
                                                        )}>
                                                            {t.priority}
                                                        </span>
                                                        <span className={cn(
                                                            "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                                                            t.status === "Resolved" ? "bg-green-500/10 text-green-400 border border-green-500/20" :
                                                                t.status === "In Progress" ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20" :
                                                                    "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                                        )}>
                                                            {t.status}
                                                        </span>
                                                    </div>
                                                </div>

                                                <p className="text-xs text-gray-300 leading-relaxed font-sans">{t.description}</p>

                                                <div className="flex items-center justify-between border-t border-white/5 pt-3 mt-1 text-[11px] text-gray-500">
                                                    <div className="flex items-center gap-1">
                                                        <Clock size={12} />
                                                        <span>Filed by {t.user} on {new Date(t.createdAt).toLocaleString()}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {t.status !== "In Progress" && t.status !== "Resolved" && (
                                                            <button
                                                                onClick={() => handleUpdateTicketStatus(t.id, "In Progress")}
                                                                className="px-2 py-1 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 rounded font-semibold transition-colors"
                                                            >
                                                                Investigate
                                                            </button>
                                                        )}
                                                        {t.status !== "Resolved" && (
                                                            <button
                                                                onClick={() => handleUpdateTicketStatus(t.id, "Resolved")}
                                                                className="px-2 py-1 bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded font-semibold transition-colors"
                                                            >
                                                                Mark Resolved
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleDeleteTicket(t.id)}
                                                            className="p-1 hover:bg-red-500/10 text-gray-500 hover:text-red-400 rounded transition-colors"
                                                            title="Delete Ticket"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* TAB 3: FAQ Canned Layer (Integrated UI) */}
                        {activeTab === 'faq' && (
                            <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <div className="border-b border-white/5 pb-4 mb-4">
                                    <h3 className="font-medium text-white flex items-center gap-2">
                                        <HelpCircle size={18} className="text-purple-400" />
                                        FAQ Canned Responses Cache
                                    </h3>
                                    <p className="text-xs text-gray-500 mt-1">Configure instantaneous, rule-based canned responses for high-criticality questions to bypass LLM RAG pipelines.</p>
                                </div>

                                <div className="flex flex-col gap-4 mb-6">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-[11px] text-gray-400 mb-1">Matching Keyword/Phrase</label>
                                            <input
                                                type="text"
                                                placeholder="e.g. fire emergency, evac protocol"
                                                value={newKeyword}
                                                onChange={(e) => setNewKeyword(e.target.value)}
                                                className="w-full text-xs p-2.5 bg-[#2a2a2a] border border-white/10 rounded-lg focus:outline-none text-white focus:border-purple-500 animate-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-gray-400 mb-1">Cache Status</label>
                                            <select
                                                value={newIsActive ? "Active" : "Bypass"}
                                                onChange={(e) => setNewIsActive(e.target.value === "Active")}
                                                className="w-full text-xs p-2.5 bg-[#2a2a2a] border border-white/10 rounded-lg focus:outline-none text-white focus:border-purple-500"
                                            >
                                                <option value="Active">Active / Low Latency Router</option>
                                                <option value="Bypass">Bypass / Draft Mode</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[11px] text-gray-400 mb-1">Canned Output Response</label>
                                        <textarea
                                            rows={3}
                                            placeholder="Paste deterministic message text to display..."
                                            value={newResponse}
                                            onChange={(e) => setNewResponse(e.target.value)}
                                            className="w-full text-xs p-2.5 bg-[#2a2a2a] border border-white/10 rounded-lg focus:outline-none text-white focus:border-purple-500 resize-none"
                                        ></textarea>
                                    </div>
                                    <div className="flex justify-end">
                                        <button
                                            onClick={handleAddFaq}
                                            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 transition-colors"
                                        >
                                            Add Rule
                                        </button>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3">
                                    <div className="text-xs font-semibold text-gray-400 mb-1 flex items-center gap-1">Active Rules ({faqs.length})</div>
                                    {faqs.length === 0 ? (
                                        <div className="text-center py-6 text-gray-500 text-xs">No active rules. Add one above.</div>
                                    ) : (
                                        <div className="flex flex-col gap-3 overflow-y-auto max-h-[300px] pr-2 custom-scrollbar">
                                            {faqs.map((faq) => (
                                                <div key={faq.id} className="p-3 bg-white/5 border border-white/5 rounded-lg flex items-center justify-between text-xs hover:bg-white/10 transition-colors">
                                                    <div className="space-y-1 overflow-hidden mr-4">
                                                        <div className="font-semibold text-purple-300 truncate">"{faq.keyword}"</div>
                                                        <div className="text-gray-400 whitespace-pre-wrap">{faq.response}</div>
                                                    </div>
                                                    <div className="flex items-center gap-3 shrink-0">
                                                        <span className={cn(
                                                            "text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider font-bold",
                                                            faq.is_active ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-gray-500/10 text-gray-400 border-gray-500/20"
                                                        )}>
                                                            {faq.is_active ? "Cached" : "Bypassed"}
                                                        </span>
                                                        <button 
                                                            onClick={() => setFaqToDelete(faq.id)}
                                                            className="p-1 hover:bg-red-500/10 text-gray-500 hover:text-red-400 rounded transition-colors"
                                                            title="Delete Rule"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* TAB 4: Analytics & Gap Analysis (Integrated UI) */}
                        {activeTab === 'analytics' && (
                            <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <div className="border-b border-white/5 pb-4 mb-4">
                                    <h3 className="font-medium text-white flex items-center gap-2">
                                        <BarChart2 size={18} className="text-purple-400" />
                                        Knowledge Gap Analytics
                                    </h3>
                                    <p className="text-xs text-gray-500 mt-1">Discover what support agents are asking that the knowledge base cannot currently answer.</p>
                                </div>

                                <div className="grid grid-cols-3 gap-4 mb-6">
                                    <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col">
                                        <span className="text-gray-400 text-xs font-medium">Failed Retrievals</span>
                                        <span className="text-2xl font-bold text-red-400 mt-1">{analyticsData.failed_rate}</span>
                                        <span className="text-[10px] text-gray-500 mt-1">LLM Fallback Search Rate</span>
                                    </div>
                                    <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col">
                                        <span className="text-gray-400 text-xs font-medium">Total Failed Queries</span>
                                        <span className="text-2xl font-bold text-amber-400 mt-1">{analyticsData.total_failed}</span>
                                        <span className="text-[10px] text-gray-500 mt-1">Total recorded gaps</span>
                                    </div>
                                    <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col">
                                        <span className="text-gray-400 text-xs font-medium">Tickets Escalated</span>
                                        <span className="text-2xl font-bold text-purple-400 mt-1">{tickets.length}</span>
                                        <span className="text-[10px] text-gray-500 mt-1">Unresolved issues</span>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div className="text-xs font-semibold text-gray-400 flex items-center gap-1">Top Unanswered Queries ({analyticsData.gaps.length})</div>
                                    {analyticsData.gaps.length === 0 ? (
                                        <div className="text-center py-8 text-gray-500 text-xs">No failed retrievals recorded yet.</div>
                                    ) : (
                                        <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                                            {analyticsData.gaps.map((gap, index) => (
                                                <div key={index} className="p-3 bg-red-500/5 border border-red-500/10 rounded-lg flex-col sm:flex-row flex sm:items-center justify-between text-xs hover:bg-red-500/10 transition-colors gap-2">
                                                    <div className="flex flex-col gap-0.5 overflow-hidden">
                                                        <span className="font-semibold text-gray-200 truncate">"{gap.query_text}"</span>
                                                        <span className="text-[10px] text-gray-500">Last match attempt score: {gap.highest_score.toFixed(4)} • {new Date(gap.created_at).toLocaleString()}</span>
                                                    </div>
                                                    <span className="text-[10px] text-red-400 bg-red-400/10 px-2 py-0.5 rounded font-bold flex-shrink-0 self-start sm:self-center">
                                                        Unindexed ({gap.failure_count} {gap.failure_count === 1 ? 'request' : 'requests'})
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                    </div>

                    {/* Quick Stats / Info sidebar */}
                    <div className="flex flex-col gap-6">
                        <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl">
                            <h3 className="font-medium text-white flex items-center gap-2 mb-4">
                                <Database size={18} className="text-blue-400" />
                                Database Status
                            </h3>
                            <div className="space-y-4">
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-gray-400">Vector Store</span>
                                    <span className={cn(
                                        "flex items-center gap-1.5 font-medium",
                                        systemStatus.vectorStore === "Online" ? "text-green-400" : 
                                        systemStatus.vectorStore === "Offline" ? "text-red-400" : "text-yellow-400"
                                    )}>
                                        <span className={cn(
                                            "w-2 h-2 rounded-full inline-block animate-pulse",
                                            systemStatus.vectorStore === "Online" ? "bg-green-500" : 
                                            systemStatus.vectorStore === "Offline" ? "bg-red-500" : "bg-yellow-500"
                                        )}></span>
                                        {systemStatus.vectorStore}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-gray-400">Embedding Model</span>
                                    <span className="text-gray-200">Active (Ada-002)</span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-gray-400">SQLite Base</span>
                                    <span className={cn(
                                        "flex items-center gap-1.5 font-medium",
                                        systemStatus.sqLite === "Online" ? "text-green-400" : 
                                        systemStatus.sqLite === "Offline" ? "text-red-400" : "text-yellow-400"
                                    )}>
                                        <span className={cn(
                                            "w-2 h-2 rounded-full inline-block animate-pulse",
                                            systemStatus.sqLite === "Online" ? "bg-green-500" : 
                                            systemStatus.sqLite === "Offline" ? "bg-red-500" : "bg-yellow-500"
                                        )}></span>
                                        {systemStatus.sqLite}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 shadow-xl opacity-70">
                            <h3 className="font-medium text-white flex items-center gap-2 mb-4">
                                <Settings size={18} className="text-gray-400" />
                                Advanced Settings
                            </h3>
                            <p className="text-sm text-gray-500 leading-relaxed mb-4">
                                Chunking settings, distance metrics, and prompt configurations are controlled directly by the RAG backend service.
                            </p>
                            <button className="w-full py-2 bg-white/5 hover:bg-white/10 text-xs text-white rounded-lg transition-colors cursor-not-allowed">
                                Manage Settings
                            </button>
                        </div>
                    </div>
                </div>
            </div>

        {/* Custom Deletion Confirmation Modal for FAQ rules */}
        {faqToDelete !== null && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                <div className="bg-[#1e1e1e] border border-white/10 w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl relative font-sans">
                    <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                    <div className="p-6 text-center">
                        <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                            <Trash2 size={20} />
                        </div>
                        <h3 className="text-base font-semibold text-white mb-2">Delete FAQ Rule?</h3>
                        <p className="text-xs text-gray-400 mb-6 leading-relaxed">
                            Are you sure you want to delete this FAQ rule? This will remove the instant cached response mapping.
                        </p>
                        <div className="flex gap-3 justify-center">
                            <button
                                onClick={() => setFaqToDelete(null)}
                                className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-medium text-gray-300 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={async () => {
                                    const id = faqToDelete;
                                    setFaqToDelete(null);
                                    await confirmDeleteFaq(id);
                                }}
                                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Custom Deletion Confirmation Modal for indexed documents */}
        {fileToDelete !== null && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                <div className="bg-[#1e1e1e] border border-white/10 w-full max-w-xs rounded-2xl overflow-hidden shadow-2xl relative font-sans">
                    <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                    <div className="p-6 text-center">
                        <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                            <Trash2 size={20} />
                        </div>
                        <h3 className="text-base font-semibold text-white mb-2">Delete Document?</h3>
                        <p className="text-xs text-gray-400 mb-6 leading-relaxed break-all px-2" title={fileToDelete}>
                            Are you sure you want to delete "{fileToDelete}"? This cannot be undone.
                        </p>
                        <div className="flex gap-3 justify-center">
                            <button
                                onClick={() => setFileToDelete(null)}
                                className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-medium text-gray-300 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={async () => {
                                    const fname = fileToDelete;
                                    setFileToDelete(null);
                                    await confirmDeleteFile(fname);
                                }}
                                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-colors"
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
                    "px-4 py-3 rounded-xl border flex items-center gap-3 shadow-2xl backdrop-blur-md",
                    toast.type === 'error' ? "bg-red-500/10 border-red-500/20 text-red-200" :
                    toast.type === 'success' ? "bg-green-500/10 border-green-500/20 text-green-200" :
                    "bg-white/10 border-white/10 text-gray-200"
                )}>
                    {toast.type === 'success' ? <CheckCircle2 size={16} className="text-green-400" /> : 
                     toast.type === 'error' ? <AlertCircle size={16} className="text-red-400" /> : 
                     <Loader2 size={16} className="animate-spin text-purple-400" />}
                    <span className="text-xs font-semibold">{toast.message}</span>
                    <button onClick={() => setToast(null)} className="hover:bg-white/10 p-1 rounded transition-colors text-gray-400 hover:text-white">
                        <X size={12} />
                    </button>
                </div>
            </div>
        )}
        </main>
    );
}
