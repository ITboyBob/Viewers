import React from 'react';
import { GridIcon, ClockIcon, TrashIcon } from '@radix-ui/react-icons';
import type { BusinessTeamMembership, RecentTaskList, TeamTaskList } from '@ohif/core';
import ohifMark from '../Account/assets/ohif-mark.svg';
import '../Account/Account.css';
import '../../business/components/BusinessFonts.css';
import './TeamPage.css';

export type TeamPageView = 'team' | 'recent';
export type TeamPageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TeamTaskList | RecentTaskList };
export type TeamPageProps = {
  view: TeamPageView;
  team?: BusinessTeamMembership;
  username: string;
  state: TeamPageState;
  onViewChange(view: TeamPageView): void;
  onRefresh?(): void;
  createTaskSlot?: React.ReactNode;
  memberSlot?: React.ReactNode;
  teamSelectorSlot?: React.ReactNode;
  teamActionsSlot?: React.ReactNode;
  notificationSlot?: React.ReactNode;
  taskStatusSlot?: React.ReactNode;
  onOpenTask?(taskId: string): void;
  canOpenTask?(taskId: string): boolean;
  renderPreview?(taskId: string, generation: number): React.ReactNode;
  previewGeneration?: number;
  openingTaskId?: string | null;
};

/** 只呈现读取投影及切换意图；打开意图交由业务容器验证和激活。 */
export default function TeamPage({
  view,
  team,
  username,
  state,
  onViewChange,
  onRefresh,
  memberSlot,
  teamSelectorSlot,
  teamActionsSlot,
  createTaskSlot,
  notificationSlot,
  taskStatusSlot,
  onOpenTask,
  canOpenTask,
  renderPreview,
  previewGeneration = 0,
  openingTaskId,
}: TeamPageProps) {
  const heading = view === 'team' ? '团队任务' : '最近任务';
  const Heading = view === 'team' ? 'h2' : 'h1';
  const initial = Array.from(username)[0] || '团';
  return (
    <div className="account-page team-page">
      <header className="account-header">
        <div className="account-brand">
          <img
            src={ohifMark}
            width="28"
            height="28"
            alt=""
          />
          <span className="account-brand-name">OHIF</span>
          <span className="account-brand-divider" />
          <span>影像协作</span>
        </div>
        <div className="account-workspace">
          <span className="account-workspace-dot" />
          影像协作工作区
        </div>
      </header>
      <nav
        className="team-page-space"
        aria-label="团队空间导航"
      >
        {memberSlot}
      </nav>
      <div className="team-page-workspace">
        <aside
          className="team-page-sidebar"
          aria-label="团队侧栏"
        >
          <div className="team-page-notifications">{notificationSlot}</div>
          {view === 'team' && team && (
            <div className="team-page-team-label">
              {teamSelectorSlot ?? (
                <>
                  <span
                    className="team-page-initial team-page-initial-small"
                    aria-hidden="true"
                  >
                    {initial}
                  </span>
                  <span>{team.name}</span>
                </>
              )}
            </div>
          )}
          <nav
            className="team-page-navigation"
            aria-label="任务看板"
          >
            <button
              type="button"
              aria-current={view === 'team' ? 'page' : undefined}
              onClick={() => view !== 'team' && onViewChange('team')}
            >
              <GridIcon aria-hidden="true" />
              团队任务
            </button>
            <button
              type="button"
              aria-current={view === 'recent' ? 'page' : undefined}
              onClick={() => view !== 'recent' && onViewChange('recent')}
            >
              <ClockIcon aria-hidden="true" />
              最近任务
            </button>
            <button
              type="button"
              disabled
              aria-label="回收站（暂未开放）"
              title="暂未开放"
            >
              <TrashIcon aria-hidden="true" />
              回收站
            </button>
          </nav>
        </aside>
        <main
          className="team-page-main"
          tabIndex={-1}
        >
          {view === 'team' && team && (
            <div className="team-page-team-heading">
              <span
                className="team-page-initial"
                aria-hidden="true"
              >
                {initial}
              </span>
              <div className="team-page-team-description">
                <h1>{team.name}</h1>
                {teamActionsSlot}
              </div>
            </div>
          )}
          <section
            className="team-page-task-section"
            aria-label={heading}
          >
            <div className="team-page-list-heading">
              <Heading>{heading}</Heading>
              {state.status === 'ready' && (
                <span
                  className="team-page-count"
                  aria-label="任务数量"
                >
                  {state.data.total}
                </span>
              )}
              {state.status === 'ready' && onRefresh && (
                <button
                  type="button"
                  className="team-page-refresh"
                  onClick={onRefresh}
                >
                  刷新列表
                </button>
              )}
              {createTaskSlot}
            </div>
            {state.status === 'loading' && <p role="status">正在加载任务…</p>}
            {state.status === 'error' && (
              <div role="alert">
                <p>{state.message}</p>
                {onRefresh && (
                  <button
                    className="team-page-refresh"
                    type="button"
                    onClick={onRefresh}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
            {taskStatusSlot}
            {state.status === 'ready' &&
              (state.data.items.length === 0 ? (
                <p role="status">暂无任务</p>
              ) : (
                <div className="team-page-cards">
                  {state.data.items.map(task => (
                    <article
                      className="team-page-card"
                      key={task.task_id}
                      data-task-card={task.task_id}
                    >
                      <div className="team-page-preview">
                        {renderPreview ? (
                          renderPreview(task.task_id, previewGeneration)
                        ) : (
                          <span>本地影像任务</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="team-page-card-open"
                        data-task-id={task.task_id}
                        aria-label={`打开任务 ${task.title}`}
                        disabled={!onOpenTask || !!openingTaskId}
                        onClick={() => onOpenTask?.(task.task_id)}
                      >
                        <div className="team-page-card-info">
                          <h3>{task.title}</h3>
                          <p>创建于 {new Date(task.created_at).toLocaleString()}</p>
                          <p>{canOpenTask?.(task.task_id) ? '打开任务' : '当前页面未保留影像'}</p>
                        </div>
                      </button>
                    </article>
                  ))}
                </div>
              ))}
          </section>
        </main>
      </div>
    </div>
  );
}
