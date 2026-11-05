import React, { useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppConfig } from '@state';
import { DicomMetadataStore } from '@ohif/core';
import { requiresBusinessAuth } from '../business/BusinessAuthGate';
import ModeRoute from '@routes/Mode';
import type { ModeDefinition, ModeRouteProps } from './Mode/Mode';
export type ModeRoutesOptions = Omit<ModeRouteProps, 'mode' | 'dataSourceName' | 'phaseOneMask'> & {
  modes: ModeDefinition[];
  dataSources: Array<{ sourceName: string }>;
};

function BusinessModeRoute(props: ModeRouteProps) {
  const [config] = useAppConfig();
  const location = useLocation();
  const projects = props.servicesManager.services.businessServices?.localProjects;
  const runtime = props.servicesManager.services.businessServices?.projectRuntime;
  const [, refresh] = useReducer(value => value + 1, 0);
  useEffect(() => projects?.subscribe(refresh), [projects]);
  const source =
    typeof props.dataSourceName === 'string'
      ? props.dataSourceName
      : (props.extensionManager.getActiveDataSourceDefinition()?.sourceName ??
        config.defaultDataSourceName);
  const phaseOneMask =
    !!config.phaseOneBusiness?.enabled &&
    requiresBusinessAuth(
      location.pathname,
      source,
      location.state,
      props.servicesManager.services.businessServices?.projectRuntime
    );
  const project = runtime?.getCurrent?.();
  const storage = props.servicesManager.services.businessServices?.taskStorage;
  const target = new URLSearchParams(location.search).get('task_id');
  const openedTarget = useRef<string | null>(null);
  if (target && project?.task_id === target) openedTarget.current = target;
  const shownTarget = !!target && openedTarget.current === target;
  const blocked =
    phaseOneMask &&
    shownTarget &&
    (!project || project.phase === 'invalid' || project.phase === 'disposed');
  useEffect(() => {
    if (!blocked) return;
    const stop = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['keydown', 'keypress', 'keyup'] as const;
    events.forEach(name => window.addEventListener(name, stop, true));
    return () => events.forEach(name => window.removeEventListener(name, stop, true));
  }, [blocked]);
  const validTarget =
    !target || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const [restoreError, setRestoreError] = useState('');
  const [attempt, retry] = useReducer(n => n + 1, 0);
  useEffect(() => {
    if (
      !phaseOneMask ||
      !target ||
      shownTarget ||
      !validTarget ||
      !storage ||
      !runtime ||
      !projects ||
      runtime.getCurrent?.()?.task_id === target
    )
      return;
    const controller = new AbortController();
    let transferred = false;
    let scope: ReturnType<typeof DicomMetadataStore.prepareLocalImportScope> | undefined;
    setRestoreError('');
    void storage
      .open(target, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        scope = DicomMetadataStore.prepareLocalImportScope(
          value.batch_id,
          value.successes.map(item => item.dataset)
        );
        scope.activate();
        runtime.bind(value, scope);
        transferred = true;
        refresh();
      })
      .catch(error => {
        if (!controller.signal.aborted)
          setRestoreError(error instanceof Error ? error.message : '任务加载失败');
        scope?.release();
      });
    return () => {
      controller.abort();
      if (!transferred) scope?.release();
    };
  }, [phaseOneMask, target, validTarget, storage, runtime, projects, attempt]);
  if (phaseOneMask && target && (!validTarget || (!shownTarget && project?.task_id !== target)))
    return (
      <div
        role={restoreError || !validTarget ? 'alert' : 'status'}
        className="bg-black p-4 text-white"
      >
        {!validTarget ? '任务标识无效' : restoreError || '正在从后端加载任务…'}
        {restoreError && (
          <button
            type="button"
            onClick={() => retry()}
          >
            重试加载
          </button>
        )}
      </div>
    );
  return (
    <>
      {phaseOneMask &&
        (!project || project.phase === 'invalid' || project.phase === 'disposed') && (
          <div
            role="status"
            className="bg-black px-3 text-white"
          >
            {shownTarget
              ? '当前项目已失效，请返回列表重新确认读取资格。'
              : '当前项目已失效，请重新导入；本页不会恢复先前项目。'}
          </div>
        )}
      <div
        className="h-full w-full"
        {...(blocked ? { inert: '' } : {})}
      >
        <ModeRoute
          {...props}
          phaseOneMask={phaseOneMask}
        />
      </div>
    </>
  );
}

/*
  Routes uniquely define an entry point to:
  - A mode
  - Linked to a data source
  - With a specified data set.

  The full route template is:

  /:modeId/:modeRoute/:sourceType/?queryParameters=example

  Where:
  :modeId - Is the mode selected.
  :modeRoute - Is the route within the mode to select.
  :sourceType - Is the data source identifier, which specifies which DataSource to use.
  ?queryParameters - Are query parameters as defined by data source.

  A default source can be specified at the app level configuration, and then that source is used if :sourceType is omitted:

  /:modeId/:modeRoute/?queryParameters=example
 */
export default function buildModeRoutes({
  modes,
  dataSources,
  extensionManager,
  servicesManager,
  commandsManager,
  hotkeysManager,
}: ModeRoutesOptions) {
  const routes = [];
  const dataSourceNames = [];

  dataSources.forEach(dataSource => {
    const { sourceName } = dataSource;
    if (!dataSourceNames.includes(sourceName)) {
      dataSourceNames.push(sourceName);
    }
  });

  modes.forEach(mode => {
    // todo: for each route. add route to path.
    dataSourceNames.forEach(dataSourceName => {
      const path = `${mode.routeName}/${dataSourceName}`;

      // TODO move up.
      const children = () => (
        <BusinessModeRoute
          mode={mode}
          dataSourceName={dataSourceName}
          extensionManager={extensionManager}
          servicesManager={servicesManager}
          commandsManager={commandsManager}
          hotkeysManager={hotkeysManager}
        />
      );

      routes.push({
        path,
        children,
        private: true,
      });
    });

    // Add active DataSource route.
    // This is the DataSource route for the active data source defined in ExtensionManager.getActiveDataSource
    const path = `${mode.routeName}`;

    // TODO move up.
    const children = () => (
      <BusinessModeRoute
        mode={mode}
        extensionManager={extensionManager}
        servicesManager={servicesManager}
        commandsManager={commandsManager}
        hotkeysManager={hotkeysManager}
      />
    );

    routes.push({
      path,
      children,
      private: true,
    });
  });

  return routes;
}
