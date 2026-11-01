import React from 'react';
import { useLocation } from 'react-router-dom';
import { useAppConfig } from '@state';
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
  return (
    <ModeRoute
      {...props}
      phaseOneMask={phaseOneMask}
    />
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
