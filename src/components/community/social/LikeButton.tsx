/**
 * «إعجاب» — the heart on a post. See CountToggle for the behaviour; this
 * file only names the write and the words.
 */
import { Heart } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { socialApi } from './api';
import CountToggle from './CountToggle';
import { likesLabel, socialLang, useSocialStrings } from './strings';

export interface LikeButtonProps {
  postId: string;
  liked: boolean;
  count: number;
  size?: 'sm' | 'md';
  onChange?: (liked: boolean, count: number) => void;
  className?: string;
}

export default function LikeButton({ postId, liked, count, size = 'md', onChange, className }: LikeButtonProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const l = socialLang(lang);
  return (
    <CountToggle
      on={liked}
      count={count}
      size={size}
      labelOn={s.unlike}
      labelOff={s.like}
      countLabel={(n) => likesLabel(n, l)}
      icon={(on, cls) => <Heart className={cls} strokeWidth={on ? 2 : 1.75} />}
      toggle={(next) => (next ? socialApi.like(postId) : socialApi.unlike(postId)).then((r) => ({ on: !!r.liked, count: Number(r.likes ?? 0) }))}
      onChange={onChange}
      failText={s.actionFailed}
      className={className}
      data-social="like"
    />
  );
}
