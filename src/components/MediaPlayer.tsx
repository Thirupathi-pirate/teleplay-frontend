import { useRef, useEffect, useState, useCallback } from 'react';
import { X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward, Download, ExternalLink, AlertTriangle, Copy, PictureInPicture2, Gauge, Settings, Music, Film, ChevronDown, ChevronUp, Subtitles } from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';
import AuthImage from './AuthImage';

export default function MediaPlayer() {
    const { previewFile: file, setPreviewFile, isPlayerMinimized, setPlayerMinimized } = useAppStore();
    
    if (!file) return null;

    return <MediaPlayerContent file={file} onClose={() => setPreviewFile(null)} isMinimized={isPlayerMinimized} setMinimized={setPlayerMinimized} />;
}

interface MediaPlayerContentProps {
    file: TelegramFile;
    onClose: () => void;
    isMinimized: boolean;
    setMinimized: (minimized: boolean) => void;
}

type FitMode = 'fit' | 'fill' | 'stretch' | 'original';

const FIT_MODE_LABELS: Record<FitMode, string> = {
    fit: 'Fit',
    fill: 'Fill',
    stretch: 'Stretch',
    original: 'Original',
};

const FIT_MODE_STYLES: Record<FitMode, React.CSSProperties> = {
    fit: { objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' },
    fill: { objectFit: 'cover', maxWidth: '100%', maxHeight: '100%' },
    stretch: { objectFit: 'fill', maxWidth: '100%', maxHeight: '100%' },
    original: { objectFit: 'contain', maxWidth: 'none', maxHeight: 'none', width: 'auto', height: 'auto' },
};

function MediaPlayerContent({ file, onClose, isMinimized, setMinimized }: MediaPlayerContentProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [isPiP, setIsPiP] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hideControlsTimeout = useRef<ReturnType<typeof setTimeout>>();
    const [publicUrl, setPublicUrl] = useState<string | null>(null);

    // Audio tracks
    const [audioTracks, setAudioTracks] = useState<{ id: number; label: string; language: string; enabled: boolean }[]>([]);
    const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);

    // Quality
    const sourceHeight = file.height ?? 1080;
    const formatResolution = (r: number) => r >= 2160 ? '4K' : r >= 1440 ? '1440p' : `${r}p`;
    const availableResolutions = [2160, 1440, 1080, 720, 480, 360].filter(r => r <= sourceHeight);
    const [selectedQuality, setSelectedQuality] = useState(sourceHeight);

    // Fit mode
    const [fitMode, setFitMode] = useState<FitMode>('fit');

    // Settings panel
    const [showSettings, setShowSettings] = useState(false);
    const [showQualitySub, setShowQualitySub] = useState(false);
    const [showAudioSub, setShowAudioSub] = useState(false);
    const [showFitSub, setShowFitSub] = useState(false);
    // Subtitles
    const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
    const [subtitleLabel, setSubtitleLabel] = useState('');
    const [subtitlesOn, setSubtitlesOn] = useState(true);
    const [showSubPicker, setShowSubPicker] = useState(false);
    const subtitleInputRef = useRef<HTMLInputElement>(null);

    const extractAudioTracks = useCallback(() => {
        const video = videoRef.current;
        if (!video || !('audioTracks' in video)) return;
        const tracks = (video as any).audioTracks;
        if (!tracks || tracks.length === 0) return;
        const list = Array.from(tracks).map((t: any, i: number) => ({
            id: i,
            label: t.label || `Track ${i + 1}`,
            language: t.language || '',
            enabled: t.enabled,
        }));
        setAudioTracks(list);
        const idx = list.findIndex((t: any) => t.enabled);
        setSelectedAudioTrack(idx >= 0 ? idx : 0);
    }, []);


    // ponytail: minimal SRT→VTT converter, covers 99% of real SRT files
    const srtToVtt = (srt: string): string => {
        let vtt = 'WEBVTT\n\n';
        vtt += srt
            .replace(/\r\n/g, '\n')
            .replace(/(\d+)\r?\n(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g, (_, _id, start, end) =>
                `
${start.replace(',', '.')} --> ${end.replace(',', '.')}`
            )
            .replace(/^\n+/, '');
        return vtt;
    };

    const handleSubtitleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            let text = reader.result as string;
            // Convert SRT to VTT if needed
            if (file.name.endsWith('.srt')) {
                text = srtToVtt(text);
            }
            // Revoke previous blob URL
            if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
            const blob = new Blob([text], { type: 'text/vtt' });
            const url = URL.createObjectURL(blob);
            setSubtitleUrl(url);
            setSubtitleLabel(file.name.replace(/\.[^.]+$/, ''));
            setSubtitlesOn(true);
            setShowSubPicker(false);
        };
        reader.readAsText(file);
    }, [subtitleUrl]);

    const switchAudioTrack = useCallback((index: number) => {
        const video = videoRef.current;
        if (!video || !('audioTracks' in video)) return;
        const tracks = (video as any).audioTracks;
        if (!tracks) return;
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].enabled = i === index;
        }
        setSelectedAudioTrack(index);
    }, []);

    // Fetch fresh file details to get latest progress
    const { data: extendedFile } = useFile(file.id);
    const { mutate: updateProgress } = useUpdateProgress();

    const isVideo = file.file_type === 'video';

    const getAbsoluteUrl = (url: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return `${window.location.origin}${url}`;
    };

    // Auto-ensure public link exists for VLC/Download/Copy
    useEffect(() => {
        const ensurePublicLink = async () => {
            const fileData = extendedFile || file;
            if (fileData.public_stream_url) {
                setPublicUrl(getAbsoluteUrl(fileData.public_stream_url));
            } else {
                try {
                    const { data } = await api.post<TelegramFile>(`/files/${file.id}/share`);
                    if (data.public_stream_url) {
                        setPublicUrl(getAbsoluteUrl(data.public_stream_url));
                    }
                } catch (err) {
                    console.error('Failed to create public link:', err);
                }
            }
        };
        ensurePublicLink();
    }, [file.id, extendedFile]);

    // Restore progress
    useEffect(() => {
        if (videoRef.current && extendedFile?.last_pos && !currentTime) {
            if (extendedFile.last_pos < (extendedFile.duration || 0) * 0.95) {
                videoRef.current.currentTime = extendedFile.last_pos;
                setCurrentTime(extendedFile.last_pos);
            }
        }
    }, [extendedFile]);

    // Save progress periodically
    useEffect(() => {
        const interval = setInterval(() => {
            if (isPlaying && videoRef.current && !error) {
                updateProgress({
                    fileId: file.id,
                    position: Math.floor(videoRef.current.currentTime),
                    duration: videoRef.current.duration
                });
            }
        }, 10000);

        return () => clearInterval(interval);
    }, [isPlaying, file.id, error, updateProgress]);

    // Save on close/pause
    const saveProgress = useCallback(() => {
        if (videoRef.current && !error) {
            updateProgress({
                fileId: file.id,
                position: Math.floor(videoRef.current.currentTime),
                duration: videoRef.current.duration
            });
        }
    }, [file.id, error, updateProgress]);

    // Save on unmount
    useEffect(() => {
        return () => saveProgress();
    }, [saveProgress]);

    const togglePlay = useCallback((e?: any) => {
        e?.stopPropagation();
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
                saveProgress();
            } else {
                videoRef.current.play();
            }
            setIsPlaying(!isPlaying);
        }
    }, [isPlaying, saveProgress]);

    const toggleMute = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.muted = !isMuted;
            setIsMuted(!isMuted);
        }
    }, [isMuted]);

    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    }, []);

    const togglePiP = async () => {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            setIsPiP(false);
        } else if (videoRef.current) {
            await videoRef.current.requestPictureInPicture();
            setIsPiP(true);
        }
    };

    const cycleSpeed = () => {
        const speeds = [0.5, 1, 1.25, 1.5, 2];
        const currentIndex = speeds.indexOf(playbackSpeed);
        const nextSpeed = speeds[(currentIndex + 1) % speeds.length];
        setPlaybackSpeed(nextSpeed);
        if (videoRef.current) {
            videoRef.current.playbackRate = nextSpeed;
        }
    };

    const handleTimeUpdate = () => {
        if (videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
        }
    };

    const handleLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration);
            setIsLoading(false);
        }
    };

    const handleWaiting = () => setIsLoading(true);
    const handlePlaying = () => setIsLoading(false);

    const handleError = () => {
        if (videoRef.current?.error) {
            const code = videoRef.current.error.code;
            if (code === 3 || code === 4) {
                setError("Browser cannot decode this video format.");
            } else {
                setError("An error occurred while trying to play this video.");
            }
            setIsLoading(false);
        }
    };

    const handleSkip = (seconds: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime += seconds;
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (videoRef.current) {
            const time = parseFloat(e.target.value);
            videoRef.current.currentTime = time;
            setCurrentTime(time);
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (videoRef.current) {
            const vol = parseFloat(e.target.value);
            videoRef.current.volume = vol;
            setVolume(vol);
            setIsMuted(vol === 0);
        }
    };

    // Keyboard controls
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (error) return;

            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                case 'j':
                    e.preventDefault();
                    handleSkip(-10);
                    break;
                case 'ArrowRight':
                case 'l':
                    e.preventDefault();
                    handleSkip(10);
                    break;
                case 'm':
                    toggleMute();
                    break;
                case 'f':
                    toggleFullscreen();
                    break;
                case 'Escape':
                    if (isFullscreen) {
                        document.exitFullscreen();
                    } else if (!isMinimized) {
                        onClose();
                    }
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen, onClose, error, isMinimized, toggleMute, togglePlay, toggleFullscreen]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimeout.current) {
            clearTimeout(hideControlsTimeout.current);
        }
        hideControlsTimeout.current = setTimeout(() => {
            if (isPlaying && !isMinimized) setShowControls(false);
        }, 3000);
    };

    // Auto-play effect
    useEffect(() => {
        if (videoRef.current && !error) {
            videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
        }
    }, [error, file.id]);

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    const token = localStorage.getItem('access_token');

    const relativeStreamUrl = `${file.stream_url}?token=${token}`;
    const authorizedStreamUrl = getAbsoluteUrl(relativeStreamUrl);
    const authorizedThumbnailUrl = file.thumbnail_url
        ? `${file.thumbnail_url}${file.thumbnail_url.includes('?') ? '&' : '?'}token=${token}`
        : null;
    const externalUrl = publicUrl || authorizedStreamUrl;
    const vlcUrl = `vlc://${externalUrl}`;

    // Fit mode style
    const videoStyle = FIT_MODE_STYLES[fitMode];

    // Common Media Element
    const MediaElement = isVideo ? (
        <video
            ref={videoRef}
            src={authorizedStreamUrl}
            className={`max-w-full max-h-full w-full h-full ${isMinimized ? 'hidden' : ''}`}
            style={videoStyle}
            onClick={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => {
                handleLoadedMetadata();
                extractAudioTracks();
            }}
            onWaiting={handleWaiting}
            onPlaying={handlePlaying}
            onError={handleError}
            controls={false}
            playsInline
        >
            {subtitleUrl && (
                <track
                    key={subtitleUrl + (subtitlesOn ? '-on' : '-off')}
                    kind="subtitles"
                    src={subtitleUrl}
                    srcLang="en"
                    label={subtitleLabel || 'Subtitles'}
                    ref={(el) => { if (el) (el as any).track.mode = subtitlesOn ? 'showing' : 'hidden'; }}
                />
            )}
        </video>
    ) : (
        <audio
            ref={videoRef as React.RefObject<HTMLAudioElement>}
            src={authorizedStreamUrl}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onWaiting={handleWaiting}
            onPlaying={handlePlaying}
            onError={handleError}
        />
    );

    return (
        <div
            ref={containerRef}
            className={`fixed transition-all duration-300 ease-in-out z-[100] ${
                isMinimized 
                    ? 'bottom-0 left-0 right-0 h-20 bg-dark-900 border-t border-white/10 shadow-2xl' 
                    : 'inset-0 bg-black flex items-center justify-center font-sans'
            }`}
            onMouseMove={!isMinimized ? handleMouseMove : undefined}
            onDoubleClick={!isMinimized ? toggleFullscreen : undefined}
        >
            {/* Media Element - Always present */}
            <div className={`w-full h-full ${isMinimized ? 'hidden' : 'flex items-center justify-center'}`}>
                {error ? (
                    <div className="text-center p-8 max-w-md glass-panel z-10 animate-scale-in">
                        <div className="w-16 h-16 rounded-2xl bg-yellow-500/20 flex items-center justify-center mx-auto mb-5 border border-yellow-500/30">
                            <AlertTriangle className="w-8 h-8 text-yellow-400" />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">Playback Not Supported</h3>
                        <p className="text-dark-300 mb-6">{error}</p>

                        <div className="flex flex-col gap-3">
                            <a
                                href={vlcUrl}
                                className="btn-primary flex items-center justify-center gap-2"
                            >
                                <ExternalLink className="w-4 h-4" />
                                Open in VLC
                            </a>
                            <div className="flex gap-3">
                                <Button
                                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(externalUrl); }}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                >
                                    <Copy className="w-4 h-4" />
                                    Copy URL
                                </Button>
                                <a
                                    href={externalUrl}
                                    download={file.file_name}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Download className="w-4 h-4" />
                                    Download
                                </a>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="mt-6 text-dark-400 hover:text-white text-sm transition-colors"
                        >
                            Close
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Audio Visualization / Thumbnail for non-video files in Fullscreen */}
                        {!isVideo && !isMinimized && (
                            <div className="text-center z-10 glass-panel p-10 animate-scale-in absolute overflow-hidden">
                                {file.thumbnail_url ? (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-dark-800 shadow-2xl overflow-hidden border border-white/10 relative group">
                                         <AuthImage 
                                            src={file.thumbnail_url} 
                                            alt={file.file_name} 
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                                         />
                                         <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end justify-center pb-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <span className="text-white text-sm font-medium">Original Artwork</span>
                                         </div>
                                    </div>
                                ) : (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-500/20 to-pink-500/20 flex items-center justify-center border border-white/[0.08] shadow-2xl relative overflow-hidden group">
                                         <div className="absolute inset-0 bg-gradient-to-tr from-primary-500/10 to-transparent animate-pulse"></div>
                                        <Music className="w-16 h-16 text-primary-400 transform transition-transform duration-500 group-hover:scale-125 drop-shadow-lg" />
                                    </div>
                                )}
                                <p className="text-2xl font-bold text-white mb-2 drop-shadow-md">{file.file_name}</p>
                                <p className="text-primary-400 font-medium">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                            </div>
                        )}
                        
                        {MediaElement}

                        {/* Loading Spinner */}
                        {isLoading && !error && !isMinimized && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-500"></div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Minimized Controls */}
            {isMinimized && (
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 p-3 h-full">
                    <div className="flex items-center gap-3 overflow-hidden flex-1 cursor-pointer" onClick={() => setMinimized(false)}>
                        <div className="w-12 h-12 rounded-lg bg-dark-800 flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/5 relative">
                            {authorizedThumbnailUrl ? (
                                <img src={authorizedThumbnailUrl} alt="Thumb" className="w-full h-full object-cover" />
                            ) : (
                                isVideo ? <Film className="w-6 h-6 text-primary-400" /> : <Music className="w-6 h-6 text-primary-400" />
                            )}
                        </div>
                        <div className="truncate flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate leading-tight">{file.file_name}</h4>
                            <p className="text-xs text-dark-400 font-mono">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-2 text-dark-300 hover:text-white">
                            <SkipBack className="w-5 h-5" />
                        </button>
                        <button 
                            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                            className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20"
                        >
                            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-2 text-dark-300 hover:text-white">
                            <SkipForward className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                         <button onClick={() => setMinimized(false)} className="p-2 text-dark-400 hover:text-white" title="Maximize">
                            <ChevronUp className="w-5 h-5" />
                        </button>
                        <button onClick={onClose} className="p-2 text-dark-400 hover:text-red-400" title="Close">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    
                    {/* Progress bar line at top */}
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-dark-800">
                        <div className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }}></div>
                    </div>
                </div>
            )}

            {/* Fullscreen Controls overlay */}
            {!error && !isMinimized && (
                <div
                    className={`absolute inset-0 transition-opacity duration-300 ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0 cursor-none'}`}
                    style={{ pointerEvents: showControls || !isPlaying ? 'auto' : 'none' }}
                >
                    {/* Top bar */}
                    <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30">
                        <div>
                            <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                            {((extendedFile?.last_pos || 0) > 0) && currentTime < 5 && (
                                <p className="text-xs text-primary-400">Resumed from {formatDuration(extendedFile?.last_pos || 0)}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                             <button
                                onClick={() => setMinimized(true)}
                                className="p-2 text-white hover:bg-white/20 rounded-full transition-colors"
                                title="Minimize"
                            >
                                <ChevronDown className="w-6 h-6" />
                            </button>
                            <button
                                onClick={onClose}
                                className="p-2 text-white hover:bg-white/20 rounded-full transition-colors"
                            >
                                <X className="w-6 h-6" />
                            </button>
                        </div>
                    </div>

                    {/* Center large controls */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30">
                        <button
                            onClick={(e) => { e.stopPropagation(); handleSkip(-10); }}
                            className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"
                        >
                            <SkipBack className="w-8 h-8" />
                        </button>

                        <button
                            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                            className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:bg-white/30 transition-all scale-100 hover:scale-105"
                        >
                            {isPlaying ? (
                                <Pause className="w-10 h-10 text-white" />
                            ) : (
                                <Play className="w-10 h-10 ml-1 text-white" />
                            )}
                        </button>

                        <button
                            onClick={(e) => { e.stopPropagation(); handleSkip(10); }}
                            className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>
                    </div>

                    {/* Bottom controls */}
                    <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30">
                        {/* Progress bar */}
                        <div className="flex items-center gap-4 mb-4 group/progress">
                            <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                            <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                <div
                                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all"
                                    style={{ width: `${progressPercent}%` }}
                                >
                                    <div className="absolute right-0 top-1/2 transform -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover/progress:opacity-100 transition-all shadow-lg shadow-primary-500/50 scale-75 group-hover/progress:scale-100"></div>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={duration || 100}
                                    value={currentTime}
                                    onChange={handleSeek}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                            </div>
                            <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">{formatDuration(Math.floor(duration))}</span>
                        </div>

                        {/* Control buttons */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={togglePlay}
                                    className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all hover:scale-105"
                                >
                                    {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                                </button>

                                {/* Volume */}
                                <div className="flex items-center gap-2 group/vol">
                                    <button
                                        onClick={toggleMute}
                                        className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    >
                                        {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                    </button>
                                    <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300">
                                        <input
                                            type="range"
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            value={isMuted ? 0 : volume}
                                            onChange={handleVolumeChange}
                                            className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                {/* Speed */}
                                <button
                                    onClick={cycleSpeed}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1
                                        ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40'
                                        : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'
                                        }`}
                                    title="Playback Speed"
                                >
                                    <Gauge className="w-4 h-4" />
                                    <span>{playbackSpeed}x</span>
                                </button>

                                {/* Settings */}
                                {isVideo && (
                                    <button
                                        onClick={() => setShowSettings(!showSettings)}
                                        className={`p-2 rounded-lg transition-all ${
                                            showSettings
                                                ? 'bg-primary-500/30 text-primary-300'
                                                : 'hover:bg-white/10 text-white/80 hover:text-white'
                                        }`}
                                        title="Settings"
                                    >
                                        <Settings className="w-5 h-5" />
                                    </button>
                                )}

                                {/* Subtitles */}
                                <button
                                    onClick={() => setShowSubPicker(true)}
                                    className={`p-2 rounded-lg transition-all ${
                                        subtitleUrl
                                            ? 'bg-primary-500/30 text-primary-300'
                                            : 'hover:bg-white/10 text-white/80 hover:text-white'
                                    }`}
                                    title="Subtitles"
                                >
                                    <Subtitles className="w-5 h-5" />
                                </button>

                                {/* PiP */}
                                {isVideo && document.pictureInPictureEnabled && (
                                    <button
                                        onClick={togglePiP}
                                        className={`p-2 rounded-lg transition-all ${isPiP
                                            ? 'bg-primary-500/30 text-primary-300'
                                            : 'hover:bg-white/10 text-white/80 hover:text-white'
                                            }`}
                                        title="Picture in Picture"
                                    >
                                        <PictureInPicture2 className="w-5 h-5" />
                                    </button>
                                )}


                                {/* VLC */}
                                <a
                                    href={vlcUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    title="Open in VLC"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <ExternalLink className="w-5 h-5" />
                                </a>

                                {/* Fullscreen */}
                                {/* Fullscreen */}
                                <button
                                    onClick={toggleFullscreen}
                                    className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                                >
                                    {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings Panel */}
            {showSettings && !isMinimized && isVideo && (
                <div className="absolute inset-0 z-40" onClick={() => setShowSettings(false)}>
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                    <div
                        className="absolute bottom-0 left-0 right-0 bg-dark-900/95 backdrop-blur-xl rounded-t-2xl border-t border-white/10 p-5 pb-8 animate-slide-up max-w-lg mx-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
                        <h3 className="text-lg font-bold text-white mb-4">Settings</h3>

                        {/* Quality */}
                        <div className="mb-4">
                            <button
                                onClick={() => setShowQualitySub(!showQualitySub)}
                                className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                            >
                                <span className="text-sm font-medium text-white">Quality</span>
                                <span className="text-sm text-primary-400">{formatResolution(selectedQuality)}</span>
                            </button>
                            {showQualitySub && (
                                <div className="mt-1 rounded-xl bg-white/5 overflow-hidden">
                                    {availableResolutions.map((r) => (
                                        <button
                                            key={r}
                                            onClick={() => { setSelectedQuality(r); setShowQualitySub(false); }}
                                            className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                                                selectedQuality === r
                                                    ? 'text-primary-300 bg-primary-500/10'
                                                    : 'text-white/70 hover:bg-white/5'
                                            }`}
                                        >
                                            {formatResolution(r)}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Fit Mode */}
                        <div className="mb-4">
                            <button
                                onClick={() => setShowFitSub(!showFitSub)}
                                className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                            >
                                <span className="text-sm font-medium text-white">Fit Mode</span>
                                <span className="text-sm text-primary-400">{FIT_MODE_LABELS[fitMode]}</span>
                            </button>
                            {showFitSub && (
                                <div className="mt-1 rounded-xl bg-white/5 overflow-hidden">
                                    {(Object.keys(FIT_MODE_LABELS) as FitMode[]).map((mode) => (
                                        <button
                                            key={mode}
                                            onClick={() => { setFitMode(mode); setShowFitSub(false); }}
                                            className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                                                fitMode === mode
                                                    ? 'text-primary-300 bg-primary-500/10'
                                                    : 'text-white/70 hover:bg-white/5'
                                            }`}
                                        >
                                            {FIT_MODE_LABELS[mode]}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>


                        {/* Subtitles */}
                        <div className="mb-4">
                            <button
                                onClick={() => subtitleUrl ? setSubtitlesOn(!subtitlesOn) : setShowSubPicker(true)}
                                className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                            >
                                <span className="text-sm font-medium text-white">Subtitles</span>
                                <span className="text-sm text-primary-400">
                                    {subtitleUrl ? (subtitlesOn ? 'On' : 'Off') : 'None'}
                                </span>
                            </button>
                            {subtitleUrl && (
                                <div className="mt-1 rounded-xl bg-white/5 overflow-hidden">
                                    <button
                                        onClick={() => { setSubtitlesOn(!subtitlesOn); setShowSettings(false); }}
                                        className="w-full px-4 py-2.5 text-left text-sm text-white/70 hover:bg-white/5"
                                    >
                                        {subtitlesOn ? 'Disable' : 'Enable'} — {subtitleLabel}
                                    </button>
                                    <button
                                        onClick={() => setShowSubPicker(true)}
                                        className="w-full px-4 py-2.5 text-left text-sm text-white/70 hover:bg-white/5"
                                    >
                                        Load different file…
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Audio Track */}
                        {audioTracks.length > 1 && (
                            <div className="mb-4">
                                <button
                                    onClick={() => setShowAudioSub(!showAudioSub)}
                                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                                >
                                    <span className="text-sm font-medium text-white">Audio Track</span>
                                    <span className="text-sm text-primary-400">
                                        {audioTracks[selectedAudioTrack]?.label || `Track ${selectedAudioTrack + 1}`}
                                    </span>
                                </button>
                                {showAudioSub && (
                                    <div className="mt-1 rounded-xl bg-white/5 overflow-hidden">
                                        {audioTracks.map((track, index) => (
                                            <button
                                                key={track.id}
                                                onClick={() => { switchAudioTrack(index); setShowAudioSub(false); }}
                                                className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                                                    selectedAudioTrack === index
                                                        ? 'text-primary-300 bg-primary-500/10'
                                                        : 'text-white/70 hover:bg-white/5'
                                                }`}
                                            >
                                                {track.label}
                                                {track.language ? ` (${track.language})` : ''}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Subtitle File Picker */}
            {showSubPicker && (
                <div className="absolute inset-0 z-50 flex items-center justify-center" onClick={() => setShowSubPicker(false)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div
                        className="relative bg-dark-900/95 backdrop-blur-xl rounded-2xl border border-white/10 p-6 animate-scale-in max-w-sm w-full mx-4"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-lg font-bold text-white mb-1">Load Subtitles</h3>
                        <p className="text-sm text-dark-300 mb-4">Select an SRT or VTT subtitle file</p>
                        <button
                            onClick={() => subtitleInputRef.current?.click()}
                            className="w-full py-4 border-2 border-dashed border-white/20 rounded-xl text-white/60 hover:border-primary-500/50 hover:text-primary-400 transition-colors flex flex-col items-center gap-2"
                        >
                            <Subtitles className="w-8 h-8" />
                            <span className="text-sm font-medium">Choose .srt or .vtt file</span>
                        </button>
                        <button
                            onClick={() => setShowSubPicker(false)}
                            className="mt-3 w-full py-2 text-dark-400 hover:text-white text-sm transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
            <input
                ref={subtitleInputRef}
                type="file"
                accept=".srt,.vtt,.sub"
                onChange={handleSubtitleFile}
                className="hidden"
            />
        </div>
    );
}

// Helper button component for cleaner code
function Button({ onClick, className, children }: { onClick?: (e: any) => void, className?: string, children: React.ReactNode }) {
    return (
        <button onClick={onClick} className={className}>
            {children}
        </button>
    );
}
