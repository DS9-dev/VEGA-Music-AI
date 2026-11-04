import { useEffect, useMemo, useRef } from 'react';
import { analyzeLyrics, fmtTime, type LyricsAnalysis } from '../../shared/lyrics';
import type { TrackParams } from '../../shared/types';
import { IcAlert, IcInfo } from '../icons';

const PLACEHOLDER = `Опишите идею песни слева и нажмите «Сгенерировать текст».

Или вставьте свой текст. Используйте теги секций:
[Verse 1]   [Pre-Chorus]   [Chorus]   [Bridge]   [Outro]
(можно по-русски: [Куплет 1], [Припев], [Бридж] — они будут переведены)

Подсказки:
• 6–10 слогов в строке — слева видно количество слогов
• ремарки и звуки (*шёпот*, (вздох)) будут удалены, чтобы их не пропели`;

export function LyricsEditor(props: {
  text: string;
  onChange: (t: string) => void;
  params: TrackParams;
  streaming: boolean;
  thinking: boolean;
  songMode?: boolean; // текст песни: длительность задана музыкой — без индикатора длины и подсказок о длине строк
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const analysis = useMemo(() => analyzeLyrics(props.text, props.params), [props.text, props.params]);

  // при потоковом наборе держим конец текста в поле зрения
  useEffect(() => {
    if (props.streaming && taRef.current) taRef.current.scrollTop = taRef.current.scrollHeight;
  }, [props.text, props.streaming]);
  // текст готов — показываем песню с начала
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !props.streaming && taRef.current) { taRef.current.scrollTop = 0; syncScroll(); }
    wasStreaming.current = props.streaming;
  }, [props.streaming]);

  const syncScroll = () => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };

  const jumpTo = (line: number) => {
    const ta = taRef.current;
    if (!ta || line < 0) return;
    const rows = props.text.split('\n');
    const start = rows.slice(0, line).reduce((s, r) => s + r.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + rows[line].length);
    ta.scrollTop = Math.max(0, line * 24 - ta.clientHeight / 2);
    syncScroll();
  };

  const showSkeleton = props.streaming && props.text.trim().length < 10;

  return (
    <>
      <div className={`lyrics-body ${props.streaming ? 'streaming' : ''}`}>
        {props.streaming && (
          <div className="stream-banner">
            <span className="typing-dots"><i /><i /><i /></span>
            {props.thinking ? 'Модель обдумывает песню…' : 'Пишем текст…'}
          </div>
        )}
        {showSkeleton && (
          <div className="skeleton">{[70, 55, 82, 60, 0, 66, 74, 50, 78].map((w, i) => <i key={i} style={{ width: `${w}%`, opacity: w ? 1 : 0 }} />)}</div>
        )}
        <div className="gutter" ref={gutterRef}>
          {analysis.lines.map((l, i) => (
            <div key={i} className={`gutter-line ${l.type === 'tag' ? 'is-tag' : ''} ${l.level}`} title={l.note}>
              {l.type === 'text' ? l.syll : ''}
            </div>
          ))}
          <div style={{ height: 200 }} />
        </div>
        <textarea
          ref={taRef}
          className={`lyrics-text ${props.streaming ? 'streaming' : ''}`}
          value={props.text}
          placeholder={props.streaming ? '' : PLACEHOLDER}
          onChange={(e) => props.onChange(e.target.value)}
          onScroll={syncScroll}
          readOnly={props.streaming}
          spellCheck={false}
          wrap="off"
        />
      </div>
      {!props.streaming && <LyricsFooter analysis={analysis} onJump={jumpTo} hasText={!!props.text.trim()} songMode={props.songMode} />}
    </>
  );
}

function LyricsFooter({ analysis, onJump, hasText, songMode }: { analysis: LyricsAnalysis; onJump: (l: number) => void; hasText: boolean; songMode?: boolean }) {
  if (!hasText) return null;
  if (songMode) {
    const ws = analysis.warnings.filter((w) => w.line >= 0 && !/слогов — длинная|Очень короткая/.test(w.message));
    if (!ws.length) return null;
    return (
      <div className="lyrics-footer">
        <div className="warn-list">
          {ws.slice(0, 30).map((w, i) => (
            <button key={i} className={`warn-item ${w.level}`} onClick={() => onJump(w.line)}>
              {w.level === 'bad' ? <IcAlert size={14} /> : <IcInfo size={14} />}<span className="ln">стр {w.line + 1}</span><span>{w.message}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  const ratio = analysis.targetSec ? analysis.estimatedSec / analysis.targetSec : 0;
  const color = ratio < 0.8 ? 'var(--bad)' : ratio < 0.92 || ratio > 1.12 ? 'var(--warn)' : 'var(--ok)';
  const maxScale = Math.max(1.25, ratio + 0.05);
  const lines = Number.isInteger(analysis.vocalLines) ? analysis.vocalLines : analysis.vocalLines.toFixed(1);
  return (
    <div className="lyrics-footer">
      <div className="meter">
        <div className="meter-top">
          <span>Текст рассчитан на <b>≈ {fmtTime(analysis.estimatedSec)}</b> из <b>{fmtTime(analysis.targetSec)}</b></span>
          <span className="dim">· {lines} строк · {analysis.sections.length} секций</span>
          <span style={{ marginLeft: 'auto', color, fontWeight: 600 }}>
            {ratio < 0.8 ? 'Мало текста' : ratio > 1.12 ? 'Многовато' : ratio < 0.92 ? 'Чуть коротко' : 'В самый раз'}
          </span>
        </div>
        <div className="meter-bar">
          <div className="meter-fill" style={{ width: `${Math.min(100, (ratio / maxScale) * 100)}%`, background: color }} />
          <div className="meter-target" style={{ left: `${(1 / maxScale) * 100}%` }} title="Целевая длительность" />
        </div>
      </div>
      {analysis.warnings.length > 0 && (
        <div className="warn-list">
          {analysis.warnings.slice(0, 30).map((w, i) => (
            <button key={i} className={`warn-item ${w.level}`} onClick={() => onJump(w.line)}>
              {w.level === 'bad' ? <IcAlert size={14} /> : <IcInfo size={14} />}
              {w.line >= 0 && <span className="ln">стр {w.line + 1}</span>}
              <span>{w.message}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
