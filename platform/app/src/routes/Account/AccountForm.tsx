import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BusinessApiError } from '../../business/BusinessApiClient';
import { useBusinessServices } from '../../business/useBusinessSession';
import AccountLayout from './AccountLayout';

export default function AccountForm({ mode }: { mode: 'login' | 'register' }) {
  const services = useBusinessServices();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const register = mode === 'register';
  const ready = !!services && username.trim().length > 0 && password.length > 0 && !pending;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy.current || !services) {
      return;
    }
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await services.session[register ? 'register' : 'login']({
        username,
        password,
      });
      if (mounted.current && result.status === 'authenticated') {
        navigate(register ? '/account/invite' : '/local-mask');
      }
    } catch (failure) {
      if (mounted.current) {
        const status = failure instanceof BusinessApiError ? failure.status : 0;
        setError(
          status === 401
            ? '用户名或密码错误，请重试。'
            : status === 409
              ? '用户名已存在，请更换用户名或登录。'
              : status === 422
                ? '请检查用户名和密码格式。'
                : '无法完成请求，请检查连接后重试。'
        );
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  };
  return (
    <AccountLayout mode={mode}>
      <form
        className="account-form"
        onSubmit={submit}
      >
        <div className="account-card">
          <h2>{register ? '注册' : '登录'}</h2>
          <div className="account-fields">
            <label
              className="account-field"
              htmlFor="account-username"
            >
              <span>用户名</span>
              <input
                id="account-username"
                name="username"
                autoComplete="username"
                placeholder="请输入用户名"
                value={username}
                onChange={event => setUsername(event.target.value)}
              />
            </label>
            <label
              className="account-field"
              htmlFor="account-password"
            >
              <span>密码</span>
              <input
                id="account-password"
                name="password"
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                placeholder="请输入密码"
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </label>
          </div>
          {!services ? (
            <p
              className="account-error"
              role="alert"
            >
              业务服务尚未初始化，不能提交。
            </p>
          ) : error ? (
            <p
              className="account-error"
              role="alert"
            >
              {error}
            </p>
          ) : (
            <p className="account-hint">填写用户名和密码后即可继续</p>
          )}
        </div>
        <button
          className="account-submit"
          type="submit"
          disabled={!ready}
          data-state={ready ? 'ready' : 'disabled'}
          aria-busy={pending}
        >
          {pending ? '提交中…' : register ? '下一步' : '登录'}
        </button>
      </form>
    </AccountLayout>
  );
}
