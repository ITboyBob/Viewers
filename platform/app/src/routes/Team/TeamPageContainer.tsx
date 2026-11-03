import React, { useEffect, useState } from 'react';
import type { BusinessServices, TeamPageApi } from '@ohif/core';
import useBusinessSession from '../../business/useBusinessSession';
import TeamPage, { TeamPageProps, TeamPageState, TeamPageView } from './TeamPage';

type Props = {
  view: TeamPageView;
  services: BusinessServices;
  onViewChange(view: TeamPageView): void;
  createTaskSlot?: React.ReactNode;
  memberSlot?: React.ReactNode;
  notificationSlot?: React.ReactNode;
  taskStatusSlot?: React.ReactNode;
  onOpenTask?(taskId: string): void;
  canOpenTask?(taskId: string): boolean;
  openingTaskId?: string | null;
};

function ReadTeamPage({
  api,
  ...props
}: Omit<TeamPageProps, 'state' | 'onRefresh'> & { api: TeamPageApi }) {
  const [attempt, refresh] = useState(0);
  const [result, setResult] = useState<{
    api: TeamPageApi;
    attempt: number;
    teamId?: string;
    state: TeamPageState;
  } | null>(null);
  const teamId = props.team?.team_id;
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const load = async () => {
      try {
        const data =
          props.view === 'team'
            ? await api.listTeamTasks(teamId!, controller.signal)
            : await api.listRecentTasks(controller.signal);
        if (current) {
          setResult({ api, attempt, teamId, state: { status: 'ready', data } });
        }
      } catch (error) {
        if (current) {
          setResult({
            api,
            attempt,
            teamId,
            state: {
              status: 'error',
              message: error instanceof Error ? error.message : '任务读取失败，请重试。',
            },
          });
        }
      }
    };
    void load();
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, props.view, teamId, attempt]);
  const state: TeamPageState =
    result?.api === api && result.attempt === attempt && result.teamId === teamId
      ? result.state
      : { status: 'loading' };
  return (
    <TeamPage
      {...props}
      state={state}
      onRefresh={() => refresh(value => value + 1)}
    />
  );
}

/** 只接受已验证会话；目标和身份改变时重建读取边界，绝不复用旧私有集合。 */
export default function TeamPageContainer({ view, services, ...slots }: Props) {
  const snapshot = useBusinessSession(services.session);
  const context = snapshot.status === 'authenticated' ? snapshot.context : null;
  const team = context?.memberships.find(member => member.team_id === snapshot.currentTeamId);
  const props = { ...slots, view, team, username: context?.user.username ?? '' };
  if (!context) {
    return (
      <TeamPage
        {...props}
        state={{ status: 'error', message: '请先验证当前会话。' }}
      />
    );
  }
  if (!services.teamPage) {
    return (
      <TeamPage
        {...props}
        state={{ status: 'error', message: '团队页读取服务未装配。' }}
      />
    );
  }
  if (view === 'team' && !team) {
    return (
      <TeamPage
        {...props}
        state={{ status: 'error', message: '无法确认当前页面的团队。' }}
      />
    );
  }
  return (
    <ReadTeamPage
      key={JSON.stringify([context.user.uid, view])}
      {...props}
      api={services.teamPage}
    />
  );
}
