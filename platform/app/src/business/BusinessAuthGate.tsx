import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { BusinessRuntime, BusinessSession } from '@ohif/core';
import { sharedLoginPath } from './localCollaboration/sharedEntry';
import useBusinessSession, { useBusinessServices } from './useBusinessSession';

export function requiresBusinessAuth(
  pathname: string,
  activeDataSource?: string,
  state?: unknown,
  runtime?: BusinessRuntime
) {
  // 与 React Router 允许多个末尾斜线的匹配行为一致，不能绕开同一路由的门禁。
  const path = pathname.replace(/\/+$/, '');
  if (
    path === '/local-mask' ||
    path === '/local-shared' ||
    path === '/account/invite' ||
    path === '/team/tasks' ||
    path === '/team/recent' ||
    path === '/segmentation/dicomlocal'
  ) {
    return true;
  }
  if (path === '/segmentation') {
    return activeDataSource === 'dicomlocal';
  }
  const marked =
    state !== null &&
    typeof state === 'object' &&
    'phaseOneMask' in state &&
    state.phaseOneMask === true;
  return /^\/microscopy(?:\/|$)/.test(path) && (marked || runtime?.phaseOneMask === true);
}

type GateProps = React.PropsWithChildren<{
  enabled: boolean;
  session?: BusinessSession;
  preservePageOnInvalidation?: boolean;
}>;

function ProtectedEntry({
  children,
  session,
  preservePageOnInvalidation,
}: GateProps & { session: BusinessSession }) {
  const snapshot = useBusinessSession(session);
  const location = useLocation();
  const [decision, setDecision] = useState<'pending' | 'granted' | 'invalid' | 'error'>('pending');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    session
      .validateCurrent()
      .then(result => {
        if (active) {
          setDecision(
            result.status === 'authenticated'
              ? 'granted'
              : result.status === 'invalid'
                ? 'invalid'
                : 'error'
          );
        }
      })
      .catch(() => {
        if (active) {
          setDecision('error');
        }
      });
    return () => {
      active = false;
    };
  }, [session, attempt]);

  if (decision === 'pending') {
    return (
      <div
        role="status"
        className="flex min-h-screen items-center justify-center bg-black text-white"
      >
        正在验证身份…
      </div>
    );
  }
  if (
    decision === 'invalid' ||
    (!preservePageOnInvalidation && decision === 'granted' && snapshot.status === 'invalid')
  ) {
    return (
      <Navigate
        to={sharedLoginPath(location.pathname, location.search, location.hash)}
        replace
      />
    );
  }
  if (decision === 'error' || (!preservePageOnInvalidation && snapshot.status === 'error')) {
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-black text-white"
      >
        <p>暂时无法验证身份，请检查连接后重试。</p>
        <button
          type="button"
          onClick={() => {
            setDecision('pending');
            setAttempt(value => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  }
  return (
    <>
      {preservePageOnInvalidation && snapshot.status === 'invalid' && (
        <div
          role="alert"
          className="bg-black text-white"
        >
          业务身份已失效，请重新登录；当前标注页不会自动跳转，也不会恢复先前项目。
        </div>
      )}
      {children}
    </>
  );
}

export default function BusinessAuthGate(props: GateProps) {
  const services = useBusinessServices();
  const location = useLocation();
  if (!props.enabled) {
    return <>{props.children}</>;
  }
  const session = props.session ?? services?.session;
  if (!session) {
    return <div role="alert">业务服务尚未初始化，无法进入受保护页面。</div>;
  }
  // 路由 key 变化时重新挂载，防止 effect 执行前短暂复用上次的放行决定。
  return (
    <ProtectedEntry
      key={location.key}
      {...props}
      session={session}
    />
  );
}
