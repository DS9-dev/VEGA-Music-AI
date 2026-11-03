import type {
  BackendStatus, JobState, LmModelInfo, LyricsChunk, LyricsResult, NewVoiceSpec, RemakeSpec, RewriteResult, RewriteSpec, Settings, SongImportSpec, SongItem,
  Track, TrackParams, VoiceCheck, VoiceItem, VoiceTrainProfile,
} from './types';

/** API, которое preload выставляет в window.api. */
export interface MusicApi {
  platform: string;
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    reset(): Promise<Settings>;
    pickFolder(current: string): Promise<string | null>;
  };
  status(): Promise<BackendStatus>;
  ace: { start(): Promise<void>; stop(): Promise<void> };
  lm: { models(): Promise<LmModelInfo[]> };
  lyrics: {
    generate(p: TrackParams): Promise<LyricsResult>;
    cancel(): Promise<void>;
    onChunk(cb: (c: LyricsChunk) => void): () => void;
  };
  job: {
    start(p: TrackParams, title: string, lyrics: string): Promise<string>;
    cancel(): Promise<void>;
    reset(): Promise<void>;
    get(): Promise<JobState>;
    onUpdate(cb: (s: JobState) => void): () => void;
  };
  library: {
    list(): Promise<Track[]>;
    readAudio(id: string, file: string): Promise<ArrayBuffer>;
    update(id: string, patch: Partial<Track>): Promise<Track>;
    remove(id: string): Promise<void>;
    reveal(id: string, file?: string): Promise<void>;
    openRoot(): Promise<void>;
  };
  voices: {
    list(): Promise<VoiceItem[]>;
    pickSources(): Promise<string[]>;
    create(spec: NewVoiceSpec): Promise<string>;
    retrain(id: string, profile: VoiceTrainProfile): Promise<void>;
    rename(id: string, name: string): Promise<VoiceItem>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    readAudio(id: string): Promise<ArrayBuffer>;
    exportVoice(id: string): Promise<string | null>;
    importVoice(): Promise<VoiceItem | null>;
    check(): Promise<VoiceCheck>;
    revoice(trackId: string, variant: number, voiceId: string, shift: number | null): Promise<string>;
    openRoot(): Promise<void>;
  };
  songs: {
    list(): Promise<SongItem[]>;
    pick(): Promise<string | null>;
    importSong(spec: SongImportSpec): Promise<string>;
    update(id: string, patch: { title?: string; lyrics?: string; rewrite?: SongItem['rewrite'] | null }): Promise<SongItem>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    readAudio(id: string, which: 'source' | 'vocals' | 'instrumental'): Promise<ArrayBuffer>;
    rewrite(id: string, spec: RewriteSpec): Promise<RewriteResult>;
    cancelRewrite(): Promise<void>;
    onChunk(cb: (c: LyricsChunk) => void): () => void;
    cleanup(id: string): Promise<SongItem>;
    analyzeStyle(id: string): Promise<SongItem>;
    remake(spec: RemakeSpec): Promise<string>;
    openRoot(): Promise<void>;
  };
  win: { minimize(): void; maximize(): void; close(): void };
}

declare global {
  interface Window { api: MusicApi }
}
