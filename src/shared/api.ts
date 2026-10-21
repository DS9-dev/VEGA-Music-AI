import type { BackendStatus, JobState, LmModelInfo, LyricsChunk, LyricsResult, Settings, Track, TrackParams } from './types';

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
  win: { minimize(): void; maximize(): void; close(): void };
}

declare global {
  interface Window { api: MusicApi }
}
