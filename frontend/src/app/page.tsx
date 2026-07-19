"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ChatInterface from "../components/ChatInterface";

export default function Home() {
    const router = useRouter();
    const [role, setRole] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const storedRole = localStorage.getItem('role');

        if (!token) {
            router.push('/login');
        } else {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRole(storedRole);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoading(false);
        }
    }, [router]);

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        router.push('/login');
    };

    if (loading) return <div className="h-[100dvh] bg-[#212121] text-white flex items-center justify-center">Loading...</div>;

    return (
        <main className="h-[100dvh] w-full bg-[#212121] flex flex-col relative overflow-hidden">
            <div className="flex-1 w-full h-full">
                <ChatInterface role={role} handleLogout={handleLogout} />
            </div>
        </main>
    );
}
