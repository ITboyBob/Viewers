import { useNavigate } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';

/** 不等待网络清除本地身份；警告属于注销时的代次，不能污染之后的新登录。 */
export default function useBusinessLogout(services: BusinessServices) {
  const navigate = useNavigate();
  return typeof services.session.logout !== 'function'
    ? undefined
    : () => {
        const pending = services.session.logout();
        navigate('/account/login', { replace: true });
        void pending.catch(() => {
          if (services.session.getSnapshot().status === 'invalid') {
            navigate('/account/login', {
              replace: true,
              state: { logoutWarning: '本地已退出，服务端撤销未确认' },
            });
          }
        });
      };
}
