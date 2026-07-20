'use client';

import { useState, useRef } from 'react';
import { UploadCloud, FileType, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { apiJson } from "../lib/api";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface UploadProps {
    onUploadSuccess?: () => void;
}

export default function UploadComponent({ onUploadSuccess }: UploadProps = {}) {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const [progressNote, setProgressNote] = useState('');
    const [chunkCount, setChunkCount] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setFile(e.target.files[0]);
            setStatus('idle');
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            setFile(e.dataTransfer.files[0]);
            setStatus('idle');
        }
    };

    const handleUpload = async () => {
        if (!file) return;

        setStatus('uploading');
        setProgressNote('Uploading file...');

        const formData = new FormData();
        formData.append('file', file);

        try {
            // The backend now returns 202 immediately and indexes in the
            // background, so we poll for completion instead of holding the
            // request open until a large PDF finishes (or times out).
            const { id } = await apiJson<{ id: number; filename: string; status: string }>(
                '/upload',
                { method: 'POST', body: formData }
            );

            setProgressNote('Extracting text and building embeddings...');

            const startedAt = Date.now();
            const TIMEOUT_MS = 5 * 60 * 1000;

            while (true) {
                await new Promise(r => setTimeout(r, 1500));

                if (Date.now() - startedAt > TIMEOUT_MS) {
                    throw new Error('Indexing is taking longer than expected. Check the document list for its status.');
                }

                const s = await apiJson<{ status: string; chunk_count: number; detail?: string }>(
                    `/files/${id}/status`
                );

                if (s.status === 'indexed') {
                    setChunkCount(s.chunk_count);
                    break;
                }
                if (s.status === 'error') {
                    throw new Error(s.detail || 'Indexing failed.');
                }
                setProgressNote(
                    s.status === 'processing'
                        ? 'Extracting text and building embeddings...'
                        : 'Queued for indexing...'
                );
            }

            setStatus('success');
            if (onUploadSuccess) onUploadSuccess();
            setTimeout(() => {
                setFile(null);
                setStatus('idle');
                setChunkCount(null);
            }, 4000);
        } catch (err: unknown) {
            setStatus('error');
            setErrorMessage(err instanceof Error ? err.message : 'Failed to upload and index document.');
            if (onUploadSuccess) onUploadSuccess(); // refresh list so an errored doc shows up
        }
    };

    return (
        <div className="bg-[#1e1e1e] border border-white/5 rounded-2xl p-6 md:p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-blue-500 to-cyan-400"></div>

            <h3 className="font-semibold text-xl mb-6 text-white flex items-center gap-2">
                <UploadCloud className="text-purple-400" />
                Upload Document
            </h3>

            <div
                className={cn(
                    "border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-all duration-300 cursor-pointer shadow-inner",
                    isDragging ? "border-purple-500 bg-purple-500/10 scale-[1.02]" : "border-white/10 bg-[#252525] hover:border-white/30 hover:bg-[#2a2a2a]",
                    file ? "border-green-500/50 bg-green-500/5 hover:border-green-500/70" : ""
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                    accept=".pdf,.txt,.doc,.docx"
                />

                {!file ? (
                    <>
                        <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 transition-transform group-hover:scale-110 duration-300">
                            <UploadCloud size={32} className="text-gray-400" />
                        </div>
                        <p className="text-white font-medium text-lg mb-1">Click to upload or drag and drop</p>
                        <p className="text-gray-500 text-sm">PDF, TXT, DOC up to 50MB</p>
                    </>
                ) : (
                    <>
                        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-4">
                            <FileType size={32} className="text-green-400" />
                        </div>
                        <p className="text-white font-medium text-lg mb-1 truncate max-w-[200px] sm:max-w-xs md:max-w-sm">{file.name}</p>
                        <p className="text-gray-400 text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </>
                )}
            </div>

            {file && status === 'idle' && (
                <div className="mt-8 flex justify-end animate-in fade-in slide-in-from-bottom-4 duration-300">
                    <button
                        onClick={handleUpload}
                        className="bg-white text-black px-6 py-2.5 rounded-xl font-medium hover:bg-gray-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_25px_rgba(255,255,255,0.2)] flex items-center gap-2"
                    >
                        Upload & Index
                        <UploadCloud size={18} />
                    </button>
                </div>
            )}

            {status === 'uploading' && (
                <div className="mt-8 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center gap-4 animate-in fade-in duration-300">
                    <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                        <Loader2 className="animate-spin text-blue-400" size={20} />
                    </div>
                    <div>
                        <p className="text-blue-100 font-medium text-sm">{progressNote || 'Uploading and Vectorizing...'}</p>
                        <p className="text-blue-300/70 text-xs">Indexing runs in the background — this page stays responsive.</p>
                    </div>
                </div>
            )}

            {status === 'success' && (
                <div className="mt-8 p-4 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-4 animate-in fade-in duration-300">
                    <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="text-green-400" size={20} />
                    </div>
                    <div>
                        <p className="text-green-100 font-medium text-sm">Successfully Indexed!</p>
                        <p className="text-green-300/70 text-xs">
                            {chunkCount !== null
                                ? `${chunkCount} searchable chunks are now live in the knowledge base.`
                                : "The document is now active in the AI Support Assistant's memory."}
                        </p>
                    </div>
                </div>
            )}

            {status === 'error' && (
                <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-4 animate-in fade-in duration-300">
                    <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
                        <AlertCircle className="text-red-400" size={20} />
                    </div>
                    <div>
                        <p className="text-red-100 font-medium text-sm">Upload Failed</p>
                        <p className="text-red-300/70 text-xs">{errorMessage}</p>
                    </div>
                </div>
            )}
        </div>
    );
}
