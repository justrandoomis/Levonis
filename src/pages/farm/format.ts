import type { Language } from '../../translations';
import type { LeaderboardBoard } from '../../lib/farmApi';

export function formatInt(n: number): string {
  return (n || 0).toLocaleString('en-US');
}

export function formatCoins(n: number): string {
  return formatInt(n) + ' FC';
}

export function formatSignedCoins(n: number): string {
  const v = n || 0;
  return (v > 0 ? '+' : '') + formatInt(v) + ' FC';
}

export function formatPercent(n: number): string {
  return Math.round((n || 0) * 100) + '%';
}

export function formatStars(n: number): string {
  return (n || 0).toFixed(1) + ' ★';
}

export function starsFromBp(bp: number): number {
  return Math.max(0, Math.min(5, (bp || 0) / 1000));
}

export function nameOf(
  item: { name?: string; name_ar?: string; name_ckb?: string } | null | undefined,
  lang: Language = 'ar'
): string {
  if (!item) return '';
  if (lang === 'ar') return item.name_ar || item.name || '';
  if (lang === 'ckb') return item.name_ckb || item.name_ar || item.name || '';
  return item.name || item.name_ar || '';
}

export function leaderboardScore(score: number, board: LeaderboardBoard): string {
  switch (board) {
    case 'reputation':
      return formatInt(score) + ' Rep';
    case 'farm_value':
      return formatCoins(score);
    case 'jobs_delivered':
      return formatInt(score) + ' jobs';
    default:
      return formatInt(score);
  }
}
