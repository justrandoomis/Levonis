/**
 * /leaderboards — server-computed boards from GET /api/farm/leaderboard. Open
 * to guests (the route is the one public farm read). Rows carry only what the
 * server sends — username, avatar, farm name, score — and the viewer's own row
 * is highlighted by username when signed in. Nobody having played is an empty
 * state, not a fabricated table.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { Segmented } from '../components/ui/Segmented';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import SafeImage from '../components/ui/SafeImage';
import { farmApi, LEADERBOARD_BOARDS, type LeaderboardBoard, type LeaderboardRow } from '../lib/farmApi';
import { FARM_STRINGS, type FarmStrings } from './farm/strings';
import { leaderboardScore } from './farm/format';
import { GamesBody, GamesHeader, GamesPage } from './farm/PageChrome';
import { PANEL } from './farm/ui';

function boardLabel(board: LeaderboardBoard, s: FarmStrings): string {
  switch (board) {
    case 'reputation':
      return s.lbBoardReputation;
    case 'farm_value':
      return s.lbBoardFarmValue;
    case 'jobs_delivered':
      return s.lbBoardJobs;
  }
}

function initials(row: LeaderboardRow): string {
  const src = row.username || row.farm_name || '';
  return src.trim().slice(0, 1).toUpperCase() || '·';
}

export default function Leaderboards() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const { user } = useAuth();
  const [board, setBoard] = useState<LeaderboardBoard>('reputation');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (b: LeaderboardBoard) => {
    setRows(null);
    setError(null);
    try {
      const res = await farmApi.leaderboard(b, 50);
      setRows(res.rows ?? []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load(board);
  }, [board, load]);

  return (
    <GamesPage>
      <GamesHeader title={s.lbTitle} back={s.back} fallback="/games" />
      <GamesBody>
        <Segmented
          group="farm-board"
          label={s.lbBoardsLabel}
          value={board}
          onChange={(id) => setBoard(id as LeaderboardBoard)}
          dataAttr="data-lb-board"
          items={LEADERBOARD_BOARDS.map((b) => ({
            id: b,
            label: boardLabel(b, s),
            accent: { indicator: 'bg-[#BAA369]/10 border-[#BAA369]/40', text: 'text-[#BAA369]' },
          }))}
        />

        {error ? (
          <ErrorState error={error} onRetry={() => void load(board)} />
        ) : rows === null ? (
          <SkeletonGroup className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-2xl" />
            ))}
          </SkeletonGroup>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Trophy aria-hidden="true" className="w-6 h-6" />} title={s.lbEmptyTitle} description={s.lbEmptyDesc} />
        ) : (
          <ol className="space-y-2" data-lb-rows={rows.length}>
            {rows.map((row, i) => {
              const rank = typeof row.rank === 'number' ? row.rank : i + 1;
              const mine = !!user?.username && row.username === user.username;
              return (
                <li
                  key={`${row.username ?? row.farm_name}-${rank}`}
                  data-lb-row={rank}
                  data-lb-mine={mine || undefined}
                  className={`${PANEL} flex items-center gap-3 px-3 py-2.5 ${mine ? 'border-[#BAA369]/50 bg-[#BAA369]/[0.06]' : ''}`}
                >
                  <span className={`w-7 text-center font-black tabular-nums text-[14px] ${rank <= 3 ? 'text-[#BAA369]' : 'text-zinc-500'}`} dir="ltr" aria-label={`${s.lbRank} ${rank}`}>
                    {rank}
                  </span>
                  <span className="w-9 h-9 rounded-full overflow-hidden bg-zinc-800 border border-white/10 shrink-0 flex items-center justify-center text-zinc-300 font-bold text-[13px]">
                    {row.avatar_key ? <SafeImage src={`/files/${row.avatar_key}`} alt="" aspect="auto" className="w-9 h-9" imgClassName="w-full h-full" /> : initials(row)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-white font-bold text-[13.5px] truncate">
                      {row.farm_name}
                      {mine && <span className="ms-2 text-[10px] font-bold text-[#BAA369] align-middle">{s.lbYou}</span>}
                    </span>
                    {row.username && (
                      <span className="block text-[11px] text-zinc-500 truncate" dir="ltr">
                        @{row.username}
                      </span>
                    )}
                  </span>
                  {/* The reputation score is the server's basis points, always — see leaderboardScore. */}
                  <span className="text-[#BAA369] font-black tabular-nums text-[14px] shrink-0" dir="ltr">
                    {leaderboardScore(board, row.score)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </GamesBody>
    </GamesPage>
  );
}
