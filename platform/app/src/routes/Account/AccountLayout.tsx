import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  sharedAuthSearch,
  sharedAuthTaskFromSearch,
} from '../../business/localCollaboration/sharedEntry';
import ohifMark from './assets/ohif-mark.svg';
import './Account.css';

type Props = React.PropsWithChildren<{ mode: 'login' | 'register' | 'invite' }>;
export default function AccountLayout({ mode, children }: Props) {
  const location = useLocation();
  const sharedTaskId = sharedAuthTaskFromSearch(location.search, location.hash);
  const authSearch = sharedTaskId ? sharedAuthSearch(sharedTaskId) : '';
  const register = mode === 'register';
  const invite = mode === 'invite';
  return (
    <div className="account-page">
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
      <main className="account-main">
        <div className="account-content">
          <div className="account-guide">
            {((register && !sharedTaskId) || invite) && (
              <p className="account-steps">
                {invite ? (
                  <>
                    01 创建账号{'    —    '}
                    <span>02 邀请成员</span>
                  </>
                ) : (
                  <>
                    <span>01 创建账号</span>
                    {'    —    02 邀请成员'}
                  </>
                )}
              </p>
            )}
            <h1>{invite ? '是否还有其他人加入你？' : '欢迎'}</h1>
            <p>
              {invite
                ? '输入对方用户名，邀请加入你的团队'
                : sharedTaskId
                  ? register
                    ? '创建账号后进入共享影像'
                    : '登录后进入共享影像'
                  : register
                    ? '创建账号，下一步邀请团队成员'
                    : '登录后继续你的影像协作'}
            </p>
          </div>
          {children}
          {!invite && (
            <p className="account-switch">
              {register ? '已有账号？ ' : '还没有账号？ '}
              <Link to={`${register ? '/account/login' : '/account/register'}${authSearch}`}>
                {register ? '登录' : '注册'}
              </Link>
            </p>
          )}
        </div>
      </main>
      <footer className="account-footer">
        <span>OHIF Viewer · 协作工具</span>
        <span>桌面端 · 深色模式</span>
      </footer>
    </div>
  );
}
