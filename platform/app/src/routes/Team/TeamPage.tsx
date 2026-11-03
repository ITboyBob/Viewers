import React from 'react';
import { GridIcon, ClockIcon, TrashIcon } from '@radix-ui/react-icons';
import type { BusinessTeamMembership, RecentTaskList, TeamTaskList } from '@ohif/core';
import ohifMark from '../Account/assets/ohif-mark.svg';
import preview from './assets/team-task-preview.png';
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
  ownedTeam?: BusinessTeamMembership;
  username: string;
  state: TeamPageState;
  onViewChange(view: TeamPageView): void;
  onRefresh?(): void;
  memberSlot?: React.ReactNode;
  notificationSlot?: React.ReactNode;
};

/** 只呈现读取投影及切换意图；卡片不入台，不产生真实访问记录。 */
export default function TeamPage({
  view,
  ownedTeam,
  username,
  state,
  onViewChange,
  onRefresh,
  memberSlot,
  notificationSlot,
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
        <span>团队空间</span>
      </nav>
      <div className="team-page-workspace">
        <aside
          className="team-page-sidebar"
          aria-label="团队侧栏"
        >
          <div className="team-page-notifications">{notificationSlot}</div>
          {view === 'team' && ownedTeam && (
            <div className="team-page-team-label">
              <span
                className="team-page-initial team-page-initial-small"
                aria-hidden="true"
              >
                {initial}
              </span>
              <span>{ownedTeam.name}</span>
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
        <main className="team-page-main">
          {view === 'team' && ownedTeam && (
            <div className="team-page-team-heading">
              <span
                className="team-page-initial"
                aria-hidden="true"
              >
                {initial}
              </span>
              <div className="team-page-team-description">
                <h1>{ownedTeam.name}</h1>
                <p>影像协作，从这里开始</p>
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
            {state.status === 'ready' &&
              (state.data.items.length === 0 ? (
                <p role="status">暂无任务</p>
              ) : (
                <div className="team-page-cards">
                  {state.data.items.map(task => (
                    <article
                      className="team-page-card"
                      key={task.task_id}
                    >
                      <div className="team-page-preview">
                        {task.preview_key === 'abdominal-ct' ? (
                          <img
                            src={preview}
                            alt="示例影像预览"
                          />
                        ) : (
                          <span>暂无示例预览</span>
                        )}
                      </div>
                      <div className="team-page-card-info">
                        <h3>{task.title}</h3>
                        <p>{task.subtitle}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ))}
            <p
              className="team-page-demo"
              role="note"
            >
              示例数据：任务、预览及历史记录仅用于演示，不代表真实访问或任务授权。
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
