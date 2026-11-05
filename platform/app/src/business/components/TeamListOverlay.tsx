import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CheckIcon, ChevronRightIcon, HomeIcon } from '@radix-ui/react-icons';
import type { BusinessTeamMembership } from '@ohif/core';

export default function TeamListOverlay({
  contentRef,
  suppressCloseFocusRef,
  ownedTeam,
  teams,
  currentTeamId,
  onSelect,
  trigger,
}: {
  ownedTeam?: BusinessTeamMembership;
  teams?: BusinessTeamMembership[];
  currentTeamId?: string | null;
  onSelect?(id: string): Promise<void>;
  contentRef?: React.RefObject<HTMLDivElement>;
  suppressCloseFocusRef?: React.RefObject<boolean>;
  trigger?: React.ReactElement;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // 窄屏两侧均容不下完整菜单时，改在入口下方展开，不压缩文字或溢出视口。
    const media = window.matchMedia?.('(max-width: 560px)');
    if (!media) {
      return;
    }
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return (
    <Popover.Root
      open={open}
      onOpenChange={setOpen}
    >
      <Popover.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            className="business-member-team-trigger"
            onKeyDown={event => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <HomeIcon aria-hidden="true" />
            查看我的团队
            <ChevronRightIcon
              className="business-team-chevron"
              aria-hidden="true"
            />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          role="menu"
          aria-label="团队列表"
          className="business-team-panel shadow-md"
          side={compact ? 'bottom' : 'right'}
          align="start"
          sideOffset={compact ? 8 : 24}
          collisionPadding={8}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setOpen(false);
            }
          }}
          onKeyPress={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          onCloseAutoFocus={event => {
            if (suppressCloseFocusRef?.current) {
              event.preventDefault();
            }
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="business-team-heading">我的团队</div>
          {(teams ?? (ownedTeam ? [ownedTeam] : [])).map(team => (
            <button
              key={team.team_id}
              type="button"
              role="menuitemradio"
              aria-checked={team.team_id === (currentTeamId ?? ownedTeam?.team_id)}
              aria-disabled={busy || !onSelect}
              disabled={busy || !onSelect}
              className="business-team-current"
              onClick={async () => {
                if (!onSelect) return;
                setBusy(true);
                setError('');
                try {
                  await onSelect(team.team_id);
                  if (alive.current) setOpen(false);
                } catch (failure) {
                  if (alive.current)
                    setError(failure instanceof Error ? failure.message : '切换团队失败');
                } finally {
                  if (alive.current) setBusy(false);
                }
              }}
            >
              <HomeIcon aria-hidden="true" />
              <span className="business-team-name">{team.name}</span>
              {team.team_id === (currentTeamId ?? ownedTeam?.team_id) && (
                <CheckIcon
                  className="business-team-check"
                  role="img"
                  aria-label="当前团队"
                />
              )}
            </button>
          ))}
          {error && <p role="alert">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
