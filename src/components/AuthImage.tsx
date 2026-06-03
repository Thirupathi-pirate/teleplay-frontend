import { useState, useEffect, useRef } from 'react';

interface AuthImageProps {
    src: string;
    alt: string;
    className?: string;
}

export default function AuthImage({ src, alt, className }: AuthImageProps) {
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const blobUrlRef = useRef<string | null>(null);

    const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024; // 5MB limit

    useEffect(() => {
        blobUrlRef.current = null;
        setBlobUrl(null);
        setError(false);

        const token = localStorage.getItem('access_token');
        if (!token || !src) {
            setError(true);
            return;
        }

        let cancelled = false;

        fetch(src, {
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(res => {
                if (!res.ok) throw new Error('Auth failed');
                const contentLength = res.headers.get('content-length');
                if (contentLength && parseInt(contentLength) > MAX_THUMBNAIL_BYTES) {
                    throw new Error('Thumbnail too large');
                }
                return res.blob();
            })
            .then(blob => {
                if (cancelled) return;
                if (blob.size > MAX_THUMBNAIL_BYTES) {
                    throw new Error('Thumbnail too large');
                }
                const url = URL.createObjectURL(blob);
                blobUrlRef.current = url;
                setBlobUrl(url);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            });

        return () => {
            cancelled = true;
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, [src]);

    if (error || !blobUrl) return null;

    return <img src={blobUrl} alt={alt} className={className} />;
}
