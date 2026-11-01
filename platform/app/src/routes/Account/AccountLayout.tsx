import React from 'react';
import { Link } from 'react-router-dom';
import ohifMark from './assets/ohif-mark.svg';
import './Account.css';

type Props = React.PropsWithChildren<{ mode: 'login' | 'register' }>;
export default function AccountLayout({ mode, children }: Props) {
  const register = mode === 'register';
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
            {register && (
              <p className="account-steps">
                <span>01 创建账号</span>
                {'    —    02 邀请成员'}
              </p>
            )}
            <h1>欢迎</h1>
            <p>{register ? '创建账号，下一步邀请团队成员' : '登录后继续你的影像协作'}</p>
          </div>
          {children}
          <p className="account-switch">
            {register ? '已有账号？ ' : '还没有账号？ '}
            <Link to={register ? '/account/login' : '/account/register'}>
              {register ? '登录' : '注册'}
            </Link>
          </p>
        </div>
      </main>
      <footer className="account-footer">
        <span>OHIF Viewer · 协作工具</span>
        <span>桌面端 · 深色模式</span>
      </footer>
    </div>
  );
}
