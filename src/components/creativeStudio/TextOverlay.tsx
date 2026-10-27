/**
 * TYPING ARABIC HAPPENS IN THE DOM, NOT IN THE CANVAS (docs/CREATIVE_STUDIO.md
 * §2: the browser’s own caret and selection are correct inside a Latin run;
 * no canvas engine’s built-in editing was). A <textarea> is laid exactly over
 * the layer — its font, size, line height, width and direction at the
 * current zoom — while the layer’s drawn words are hidden. Ctrl/Cmd+Enter or
 * leaving the field keeps the words (`set_text`); Escape drops them.
 */
import { useEffect, useRef, useState } from 'react';
import { FONT_REGISTRY, type TextLayer } from '../../../packages/creativeDoc/src/schema';
import { physicalAlign, resolveDirection } from '../../../packages/creativeDoc/src/text';
import type { Box } from '../../../packages/creativeDoc/src/schema';
import { S } from './strings';
import { useText } from './shared';

/** The field is a house well (`lv-input`) whose look the inline style replaces: it must read as the layer itself. */
const FIELD = 'lv-input';

export default function TextOverlay({ layer, screen, scale, docDirection, onCommit, onCancel }: {
  layer: TextLayer;
  screen: Box;
  scale: number;
  docDirection: 'rtl' | 'ltr';
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const { w } = useText();
  const [value, setValue] = useState(layer.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const dir = resolveDirection(layer.direction, value, docDirection);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && value !== layer.text) onCommit(value);
    else onCancel();
  };
  const lines = Math.max(1, value.split('\n').length);
  return (
    <textarea
      ref={ref}
      className={FIELD}
      data-text-overlay={layer.id}
      aria-label={w(S.textEditLabel)}
      dir={dir}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
        e.stopPropagation();
      }}
      style={{
        position: 'absolute', left: screen.x, top: screen.y, width: screen.width,
        minHeight: Math.max(screen.height, lines * layer.font.size * layer.font.lineHeight * scale),
        margin: 0, padding: 0, border: 0, borderRadius: 0, boxShadow: 'none', outline: '2px dashed #3b82f6', outlineOffset: 2,
        background: 'rgba(17,18,20,0.35)', color: layer.color, caretColor: '#f59e0b', resize: 'none', overflow: 'hidden', whiteSpace: 'pre-wrap',
        fontFamily: `"${FONT_REGISTRY[layer.font.family].family}"`, fontWeight: layer.font.weight, fontSize: layer.font.size * scale,
        lineHeight: layer.font.lineHeight, letterSpacing: 0, textAlign: physicalAlign(layer.align, docDirection), zIndex: 5,
      }}
    />
  );
}
