/**
 * «حفظ» — the bookmark on a post. A save is private: the count is the
 * author's to see on the card, the list is the viewer's at /community/saved.
 */
import { Bookmark } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { socialApi } from './api';
import CountToggle from './CountToggle';
import { socialLang, useSocialStrings } from './strings';

export interface SaveButtonProps {
  postId: string;
  saved: boolean;
  count: number;
  size?: 'sm' | 'md';
  /** Show the number of saves (the author's own view); off by default — a save is private. */
  showCount?: boolean;
  onChange?: (saved: boolean, count: number) => void;
  className?: string;
}

export default function SaveButton({ postId, saved, count, size = 'md', showCount = false, onChange, className }: SaveButtonProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const l = socialLang(lang);
  return (
    <CountToggle
      on={saved}
      count={showCount ? count : 0}
      size={size}
      labelOn={s.unsave}
      labelOff={s.save}
      countLabel={(n) => (l === 'en' ? `${n} saved` : l === 'ckb' ? `${n} پاشەکەوت` : `${n} حفظ`)}
      icon={(on, cls) => <Bookmark className={cls} strokeWidth={on ? 2 : 1.75} />}
      toggle={(next) =>
        (next ? socialApi.save(postId) : socialApi.unsave(postId)).then((r) => ({ on: !!r.saved, count: showCount ? Number(r.saves ?? 0) : 0 }))
      }
      onChange={onChange}
      failText={s.actionFailed}
      className={className}
      data-social="save"
    />
  );
}
