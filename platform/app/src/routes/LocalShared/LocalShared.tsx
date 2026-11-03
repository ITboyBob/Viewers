import React, { useEffect, useReducer, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ModeRoute from '@routes/Mode';
import type { ModeRoutesOptions } from '../buildModeRoutes';
import { sharedTaskFromSearch } from '../../business/localCollaboration/sharedEntry';
export { sharedTaskFromSearch } from '../../business/localCollaboration/sharedEntry';
export default function LocalShared(props: ModeRoutesOptions) {
  const location = useLocation();
  const taskId = location.hash ? null : sharedTaskFromSearch(location.search);
  const service = props.servicesManager.services.businessServices?.localCollaboration?.sharedView;
  const [, refresh] = useReducer(value => value + 1, 0);
  const [attempt, setAttempt] = useState(0),
    [error, setError] = useState('');
  useEffect(() => service?.subscribe(refresh), [service]);
  useEffect(() => {
    if (!taskId || !service) {
      return;
    }
    let active = true;
    setError('');
    void service.open(taskId).catch(failure => {
      if (active) {
        setError(failure instanceof Error ? failure.message : '本地共享不可用');
      }
    });
    return () => {
      active = false;
      service.dispose();
    };
  }, [taskId, service, attempt]);
  const snapshot = service?.getSnapshot();
  const view = snapshot?.task_id === taskId ? snapshot : null;
  const mode = props.modes.find(value => value.routeName === view?.mode_path.split('/')[0]);
  useEffect(() => {
    if (view?.phase === 'active' && !mode) {
      service?.dispose();
      setError('当前影像模式不可用');
    }
  }, [view?.phase, mode, service]);
  if (!taskId) {
    return <div role="alert">共享任务参数无效，请重新打开完整共享入口。</div>;
  }
  if (!service) {
    return <div role="alert">共享服务尚未初始化，无法加载影像。</div>;
  }
  const visible =
    !!mode &&
    !!view &&
    (view.phase === 'active' ||
      view.phase === 'detached' ||
      (view.phase === 'invalid' && view.view_ready));
  return (
    <>
      <div
        role={error || view?.phase === 'invalid' ? 'alert' : 'status'}
        className="bg-black px-3 text-white"
      >
        {error ||
          (view?.phase === 'detached'
            ? '源窗口已离开，已停止共享；可继续查看本窗影像。'
            : view?.phase === 'invalid'
              ? '当前身份已失效，已停止共享。'
              : view?.view_ready
                ? `已进入共享：${view.title}`
                : view?.phase === 'disposed'
                  ? '本次共享已结束，请确认源窗口后重试。'
                  : '正在加载共享影像…')}
        {!visible && (error || view?.phase === 'disposed') && (
          <button
            type="button"
            onClick={() => setAttempt(value => value + 1)}
          >
            重试共享加载
          </button>
        )}
      </div>
      {visible && (
        <ModeRoute
          key={view.load_generation}
          {...props}
          mode={mode}
          dataSourceName="dicomlocal"
          phaseOneMask={false}
          sharedView={view}
        />
      )}
    </>
  );
}
